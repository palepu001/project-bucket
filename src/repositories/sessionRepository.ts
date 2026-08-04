import { randomUUID } from 'crypto';
import { sql } from '@forge/sql';
import { ensureSchema } from '../db/client';
import { nowSqlDateTime, sqlDateTimeToIso } from '../db/time';
import { Session, SessionItem, SessionStatus } from '../types/migration';

interface SessionRow {
  id: string;
  issue_id: string;
  project_id: string;
  status: SessionStatus;
  created_at: string;
  last_event_at: string;
  notified_at: string | null;
  resolved_at: string | null;
}

interface SessionItemRow {
  id: string;
  session_id: string;
  jira_attachment_id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  author_account_id: string;
  detected_at: string;
}

function toSessionItem(row: SessionItemRow): SessionItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    jiraAttachmentId: row.jira_attachment_id,
    filename: row.filename,
    size: Number(row.size_bytes),
    mimeType: row.mime_type,
    authorAccountId: row.author_account_id,
    detectedAt: sqlDateTimeToIso(row.detected_at),
  };
}

function toSession(row: SessionRow, items: SessionItem[]): Session {
  return {
    id: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    status: row.status,
    createdAt: sqlDateTimeToIso(row.created_at),
    lastEventAt: sqlDateTimeToIso(row.last_event_at),
    notifiedAt: row.notified_at ? sqlDateTimeToIso(row.notified_at) : null,
    resolvedAt: row.resolved_at ? sqlDateTimeToIso(row.resolved_at) : null,
    items,
  };
}

async function fetchItems(sessionId: string): Promise<SessionItem[]> {
  const result = await sql
    .prepare('SELECT * FROM attachment_session_items WHERE session_id = ? ORDER BY detected_at ASC')
    .bindParams(sessionId)
    .execute();
  return (result.rows as unknown as SessionItemRow[]).map(toSessionItem);
}

async function fetchSessionRow(sessionId: string): Promise<SessionRow | null> {
  const result = await sql
    .prepare('SELECT * FROM attachment_sessions WHERE id = ?')
    .bindParams(sessionId)
    .execute();
  const rows = result.rows as unknown as SessionRow[];
  return rows.length > 0 ? rows[0] : null;
}

export async function getSessionById(sessionId: string): Promise<Session | null> {
  await ensureSchema();
  const row = await fetchSessionRow(sessionId);
  if (!row) return null;
  return toSession(row, await fetchItems(sessionId));
}

/**
 * Appends one newly detected native attachment into this issue's open (PENDING)
 * bulk-detection session, creating that session first if none is open. This is
 * the accumulation half of bulk detection — grouping happens here by simply
 * reusing the same PENDING row for every attachment on the same issue until a
 * poller "claims" it (see claimQuietSession) once the burst goes quiet.
 */
export async function appendToSession(params: {
  issueId: string;
  projectId: string;
  jiraAttachmentId: string;
  filename: string;
  size: number;
  mimeType: string;
  authorAccountId: string;
}): Promise<void> {
  await ensureSchema();
  const now = nowSqlDateTime();
  const newSessionId = randomUUID();

  // Atomic insert: creates the session only if no PENDING session exists.
  // This completely eliminates the lambda concurrency race condition that spawned
  // duplicate sessions when multiple files uploaded at the exact same millisecond.
  const insert = await sql
    .prepare(
      `INSERT INTO attachment_sessions (id, issue_id, project_id, status, created_at, last_event_at)
       SELECT ?, ?, ?, 'PENDING', ?, ? FROM dual
       WHERE NOT EXISTS (
         SELECT 1 FROM attachment_sessions WHERE issue_id = ? AND status = 'PENDING'
       )`
    )
    .bindParams(newSessionId, params.issueId, params.projectId, now, now, params.issueId)
    .execute();

  const affectedRows = (insert.rows as unknown as { affectedRows: number }).affectedRows;
  let activeSessionId: string = newSessionId;

  if (affectedRows === 0) {
    // A pending session already existed, or we lost the insert race.
    const existing = await sql
      .prepare("SELECT id FROM attachment_sessions WHERE issue_id = ? AND status = 'PENDING' LIMIT 1")
      .bindParams(params.issueId)
      .execute();
    const existingRows = existing.rows as unknown as { id: string }[];
    
    if (existingRows.length > 0) {
      activeSessionId = existingRows[0].id;
      await sql
        .prepare("UPDATE attachment_sessions SET last_event_at = ? WHERE id = ? AND status = 'PENDING'")
        .bindParams(now, activeSessionId)
        .execute();
    }
  }

  // INSERT IGNORE guards against the same trigger event being redelivered
  // (Forge triggers are at-least-once) re-adding the same jira_attachment_id
  // twice — the (session_id, jira_attachment_id) unique key makes the second
  // insert a harmless no-op instead of a duplicate row.
  await sql
    .prepare(
      `INSERT IGNORE INTO attachment_session_items
        (id, session_id, jira_attachment_id, filename, size_bytes, mime_type, author_account_id, detected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bindParams(
      randomUUID(),
      activeSessionId,
      params.jiraAttachmentId,
      params.filename,
      params.size,
      params.mimeType,
      params.authorAccountId,
      now
    )
    .execute();
}

/**
 * Atomically claims the open session for `issueId` once it has been quiet
 * for `quietWindowMs` — i.e. no new attachment has landed on it recently —
 * and flips it to NOTIFIED. Returns null if there is no open session, or the
 * open session is still within its quiet window (more attachments may still
 * be arriving in this same burst), or another poll (e.g. a second browser
 * tab) already claimed it a moment earlier.
 *
 * The claim is a compare-and-swap UPDATE ... WHERE status = 'PENDING': only
 * the caller whose UPDATE actually changes a row (affectedRows === 1) is
 * the one who gets to show the popup, which is what makes "exactly one
 * popup per burst" hold even under concurrent pollers.
 */
export async function claimQuietSession(issueId: string, quietWindowMs: number): Promise<Session | null> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - quietWindowMs);
  const cutoffSql = cutoff.toISOString().slice(0, 19).replace('T', ' ');

  const candidate = await sql
    .prepare(
      "SELECT id FROM attachment_sessions WHERE issue_id = ? AND status = 'PENDING' AND last_event_at <= ? LIMIT 1"
    )
    .bindParams(issueId, cutoffSql)
    .execute();
  const candidateRows = candidate.rows as unknown as { id: string }[];
  if (candidateRows.length === 0) return null;

  const sessionId = candidateRows[0].id;
  const now = nowSqlDateTime();
  const claim = await sql
    .prepare("UPDATE attachment_sessions SET status = 'NOTIFIED', notified_at = ? WHERE id = ? AND status = 'PENDING'")
    .bindParams(now, sessionId)
    .execute();

  const affectedRows = (claim.rows as unknown as { affectedRows: number }).affectedRows;
  if (affectedRows !== 1) return null;

  return getSessionById(sessionId);
}

export async function markSessionResolved(sessionId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare("UPDATE attachment_sessions SET status = 'RESOLVED', resolved_at = ? WHERE id = ?")
    .bindParams(nowSqlDateTime(), sessionId)
    .execute();
}

export async function markSessionDismissed(sessionId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare("UPDATE attachment_sessions SET status = 'DISMISSED', resolved_at = ? WHERE id = ?")
    .bindParams(nowSqlDateTime(), sessionId)
    .execute();
}

export async function markSessionNotified(sessionId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare("UPDATE attachment_sessions SET status = 'NOTIFIED', notified_at = ? WHERE id = ?")
    .bindParams(nowSqlDateTime(), sessionId)
    .execute();
}

/**
 * Prunes resolved or dismissed upload sessions (and their associated items)
 * that are older than `retentionDays` (defaults to 7 days). Keeps Forge SQL
 * lean without leaving stale session metadata around.
 */
export async function purgeOldSessions(retentionDays = 7): Promise<number> {
  await ensureSchema();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const cutoffSql = cutoff.toISOString().slice(0, 19).replace('T', ' ');

  await sql
    .prepare(
      `DELETE FROM attachment_session_items WHERE session_id IN (
        SELECT id FROM attachment_sessions WHERE status IN ('RESOLVED', 'DISMISSED') AND last_event_at < ?
      )`
    )
    .bindParams(cutoffSql)
    .execute();

  const res = await sql
    .prepare(
      "DELETE FROM attachment_sessions WHERE status IN ('RESOLVED', 'DISMISSED') AND last_event_at < ?"
    )
    .bindParams(cutoffSql)
    .execute();

  return (res.rows as unknown as { affectedRows: number }).affectedRows || 0;
}

