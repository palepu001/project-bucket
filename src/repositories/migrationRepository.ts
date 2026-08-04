import { randomUUID } from 'crypto';
import { sql } from '@forge/sql';
import { ensureSchema } from '../db/client';
import { nowSqlDateTime, sqlDateTimeToIso, toSqlDateTime } from '../db/time';
import { MigrationItem, MigrationItemStatus, MigrationRun, MigrationRunStatus } from '../types/migration';
import { AttachmentThumbnailStatus } from '../types/attachment';

interface MigrationRunRow {
  id: string;
  issue_id: string;
  project_id: string;
  session_id: string | null;
  requested_count: number;
  migrated_count: number;
  failed_count: number;
  status: MigrationRunStatus;
  started_at: string;
  completed_at: string | null;
  triggered_by: string;
  last_activity_at: string | null;
  commit_started_at: string | null;
}

interface MigrationItemRow {
  id: string;
  migration_id: string;
  jira_attachment_id: string;
  filename: string;
  status: MigrationItemStatus;
  error_message: string | null;
  attachment_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  object_key: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  checksum: string | null;
  thumbnail_key: string | null;
  thumbnail_status: AttachmentThumbnailStatus | null;
}

// The staged state a migration item carries between the STAGE step (bytes
// verified in storage backend) and the whole-session COMMIT step (persist metadata
// + delete native copies). Kept internal to the migration pipeline — it is not
// part of the MigrationItem shape the diagnostics UI renders.
export interface StagedMigrationItem {
  id: string;
  jiraAttachmentId: string;
  filename: string;
  status: MigrationItemStatus;
  attachmentId: string | null;
  objectKey: string | null;
  mimeType: string | null;
  size: number | null;
  checksum: string | null;
  // Preview rendition the client generated from the Jira bytes and already
  // uploaded, carried through to the attachment row the commit persists.
  thumbnailKey: string | null;
  thumbnailStatus: AttachmentThumbnailStatus | null;
}

function toMigrationItem(row: MigrationItemRow): MigrationItem {
  return {
    id: row.id,
    migrationId: row.migration_id,
    jiraAttachmentId: row.jira_attachment_id,
    filename: row.filename,
    status: row.status,
    errorMessage: row.error_message,
    attachmentId: row.attachment_id,
    startedAt: row.started_at ? sqlDateTimeToIso(row.started_at) : null,
    completedAt: row.completed_at ? sqlDateTimeToIso(row.completed_at) : null,
  };
}

function toMigrationRun(row: MigrationRunRow, items: MigrationItem[]): MigrationRun {
  return {
    id: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    requestedCount: row.requested_count,
    migratedCount: row.migrated_count,
    failedCount: row.failed_count,
    status: row.status,
    startedAt: sqlDateTimeToIso(row.started_at),
    completedAt: row.completed_at ? sqlDateTimeToIso(row.completed_at) : null,
    triggeredBy: row.triggered_by,
    items,
  };
}

async function fetchItems(migrationId: string): Promise<MigrationItem[]> {
  const result = await sql
    .prepare('SELECT * FROM migration_items WHERE migration_id = ? ORDER BY started_at ASC, filename ASC')
    .bindParams(migrationId)
    .execute();
  return (result.rows as unknown as MigrationItemRow[]).map(toMigrationItem);
}

export interface CreateMigrationRunParams {
  issueId: string;
  projectId: string;
  sessionId: string | null;
  triggeredBy: string;
  items: { jiraAttachmentId: string; filename: string }[];
}

export async function createMigrationRun(params: CreateMigrationRunParams): Promise<MigrationRun> {
  await ensureSchema();
  const id = randomUUID();
  const now = nowSqlDateTime();

  await sql
    .prepare(
      `INSERT INTO migration_runs
        (id, issue_id, project_id, session_id, requested_count, migrated_count, failed_count, status, started_at, triggered_by, last_activity_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'RUNNING', ?, ?, ?)`
    )
    .bindParams(id, params.issueId, params.projectId, params.sessionId, params.items.length, now, params.triggeredBy, now)
    .execute();

  for (const item of params.items) {
    await sql
      .prepare(
        `INSERT INTO migration_items (id, migration_id, jira_attachment_id, filename, status)
         VALUES (?, ?, ?, ?, 'PENDING')`
      )
      .bindParams(randomUUID(), id, item.jiraAttachmentId, item.filename)
      .execute();
  }

  const run = await getMigrationRun(id);
  if (!run) throw new Error('Failed to read back the migration run that was just created');
  return run;
}

export async function getMigrationRun(migrationId: string): Promise<MigrationRun | null> {
  await ensureSchema();
  const result = await sql.prepare('SELECT * FROM migration_runs WHERE id = ?').bindParams(migrationId).execute();
  const rows = result.rows as unknown as MigrationRunRow[];
  if (rows.length === 0) return null;
  return toMigrationRun(rows[0], await fetchItems(migrationId));
}

export async function getActiveRunForSession(sessionId: string): Promise<MigrationRun | null> {
  await ensureSchema();
  const result = await sql
    .prepare("SELECT * FROM migration_runs WHERE session_id = ? AND status = 'RUNNING' LIMIT 1")
    .bindParams(sessionId)
    .execute();
  const rows = result.rows as unknown as MigrationRunRow[];
  if (rows.length === 0) return null;
  return toMigrationRun(rows[0], await fetchItems(rows[0].id));
}

export async function listMigrationRuns(issueId: string): Promise<MigrationRun[]> {
  await ensureSchema();
  const result = await sql
    .prepare('SELECT * FROM migration_runs WHERE issue_id = ? ORDER BY started_at DESC LIMIT 50')
    .bindParams(issueId)
    .execute();
  const rows = result.rows as unknown as MigrationRunRow[];
  const runs: MigrationRun[] = [];
  for (const row of rows) {
    runs.push(toMigrationRun(row, await fetchItems(row.id)));
  }
  return runs;
}

export async function updateMigrationItem(
  itemId: string,
  patch: {
    status: MigrationItemStatus;
    errorMessage?: string | null;
    attachmentId?: string | null;
    objectKey?: string | null;
    mimeType?: string | null;
    size?: number | null;
    checksum?: string | null;
    thumbnailKey?: string | null;
    thumbnailStatus?: AttachmentThumbnailStatus | null;
    startedAt?: boolean;
    completedAt?: boolean;
  }
): Promise<void> {
  await ensureSchema();
  const sets: string[] = ['status = ?'];
  const values: (string | number | null)[] = [patch.status];

  if (patch.errorMessage !== undefined) {
    sets.push('error_message = ?');
    values.push(patch.errorMessage);
  }
  if (patch.attachmentId !== undefined) {
    sets.push('attachment_id = ?');
    values.push(patch.attachmentId);
  }
  if (patch.objectKey !== undefined) {
    sets.push('object_key = ?');
    values.push(patch.objectKey);
  }
  if (patch.mimeType !== undefined) {
    sets.push('mime_type = ?');
    values.push(patch.mimeType);
  }
  if (patch.size !== undefined) {
    sets.push('size_bytes = ?');
    values.push(patch.size);
  }
  if (patch.checksum !== undefined) {
    sets.push('checksum = ?');
    values.push(patch.checksum);
  }
  if (patch.thumbnailKey !== undefined) {
    sets.push('thumbnail_key = ?');
    values.push(patch.thumbnailKey);
  }
  if (patch.thumbnailStatus !== undefined) {
    sets.push('thumbnail_status = ?');
    values.push(patch.thumbnailStatus);
  }
  if (patch.startedAt) {
    sets.push('started_at = ?');
    values.push(nowSqlDateTime());
  }
  if (patch.completedAt) {
    sets.push('completed_at = ?');
    values.push(nowSqlDateTime());
  }

  values.push(itemId);
  await sql.prepare(`UPDATE migration_items SET ${sets.join(', ')} WHERE id = ?`).bindParams(...values).execute();
}

/**
 * Reads the staged state of every item in a run — the object keys and verified
 * metadata the COMMIT step needs to persist attachments and delete native
 * copies for the whole session at once. Kept separate from fetchItems because
 * these columns are pipeline-internal and never surface in the diagnostics UI.
 */
export async function getStagedMigrationItems(migrationId: string): Promise<StagedMigrationItem[]> {
  await ensureSchema();
  const result = await sql
    .prepare('SELECT * FROM migration_items WHERE migration_id = ? ORDER BY started_at ASC, filename ASC')
    .bindParams(migrationId)
    .execute();
  return (result.rows as unknown as MigrationItemRow[]).map((row) => ({
    id: row.id,
    jiraAttachmentId: row.jira_attachment_id,
    filename: row.filename,
    status: row.status,
    attachmentId: row.attachment_id,
    objectKey: row.object_key,
    mimeType: row.mime_type,
    size: row.size_bytes === null ? null : Number(row.size_bytes),
    checksum: row.checksum,
    thumbnailKey: row.thumbnail_key ?? null,
    thumbnailStatus: row.thumbnail_status ?? null,
  }));
}

/**
 * Writes the final, computed state of a run in one shot. Counts are derived
 * from the terminal item statuses by the caller (services/migrationService)
 * rather than incremented as the run progresses, so this is the single place a
 * run becomes terminal and it always agrees with its items.
 */
export async function setRunFinal(
  migrationId: string,
  status: MigrationRunStatus,
  migratedCount: number,
  failedCount: number
): Promise<void> {
  await ensureSchema();
  // Clearing commit_started_at here as well as in the commit's own `finally`
  // keeps a terminal run from ever carrying a stale lease: a run that is no
  // longer RUNNING can never be recovered anyway, but leaving the token set
  // would block the retry that reopenRun sets up.
  await sql
    .prepare(
      'UPDATE migration_runs SET status = ?, migrated_count = ?, failed_count = ?, completed_at = ?, last_activity_at = ?, commit_started_at = NULL WHERE id = ?'
    )
    .bindParams(status, migratedCount, failedCount, nowSqlDateTime(), nowSqlDateTime(), migrationId)
    .execute();
}

/** Resets failed items back to PENDING, clearing any staged state from the aborted attempt. */
export async function resetItemsForRetry(migrationId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await ensureSchema();
  const placeholders = itemIds.map(() => '?').join(', ');
  await sql
    .prepare(
      `UPDATE migration_items
       SET status = 'PENDING', error_message = NULL, started_at = NULL, completed_at = NULL,
           object_key = NULL, mime_type = NULL, size_bytes = NULL, checksum = NULL,
           thumbnail_key = NULL, thumbnail_status = NULL
       WHERE migration_id = ? AND id IN (${placeholders})`
    )
    .bindParams(migrationId, ...itemIds)
    .execute();
}

/**
 * Re-opens a terminal run (FAILED or PARTIAL_FAILURE) so its commit can be retried.
 *
 * Resets `last_activity_at` to now as part of the same statement. This is not
 * bookkeeping — it is load-bearing. The run's last heartbeat is by definition
 * old (it was written during the attempt that failed, before the user read the
 * error and decided to retry), so a run re-opened without it is born already
 * past the staleness threshold: the very next poll would "recover" the retry
 * out from under itself, reset the items being re-staged, and start a second
 * concurrent pipeline.
 */
export async function reopenRun(migrationId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare(
      "UPDATE migration_runs SET status = 'RUNNING', completed_at = NULL, last_activity_at = ?, commit_started_at = NULL WHERE id = ?"
    )
    .bindParams(nowSqlDateTime(), migrationId)
    .execute();
}

/**
 * Atomically CLAIMS a RUNNING migration run for the given issue that has been
 * idle longer than `staleThresholdMs` — i.e. one whose browser died mid-run.
 *
 * The claim is a compare-and-swap, exactly like sessionRepository's
 * claimQuietSession: the candidate is selected, then a conditional UPDATE
 * re-checks the staleness predicate and bumps the heartbeat in one statement.
 * Only the caller whose UPDATE actually changes a row (affectedRows === 1)
 * gets the run back; everyone else gets null. Without that, two tabs polling
 * the same issue both read the same stale row and both start resuming it,
 * which is how a session gets migrated twice.
 *
 * A run is stale when its `last_activity_at` is older than the threshold AND
 * no commit is in flight against it (`commit_started_at`). The commit phase
 * heartbeats too, but it is checked separately so that a bug in one signal
 * cannot on its own re-open the duplicate-commit path. If `last_activity_at`
 * is NULL (runs created before the column existed), falls back to `started_at`.
 */
export async function claimStaleRunningRun(
  issueId: string,
  staleThresholdMs: number
): Promise<MigrationRun | null> {
  await ensureSchema();
  // Any RUNNING run whose last activity (or start time, for runs predating the
  // column) is before this instant is considered abandoned by its browser.
  const cutoffStr = toSqlDateTime(new Date(Date.now() - staleThresholdMs));

  const candidate = await sql
    .prepare(
      `SELECT id FROM migration_runs
       WHERE issue_id = ? AND status = 'RUNNING'
         AND COALESCE(last_activity_at, started_at) < ?
         AND (commit_started_at IS NULL OR commit_started_at < ?)
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .bindParams(issueId, cutoffStr, cutoffStr)
    .execute();

  const candidateRows = candidate.rows as unknown as { id: string }[];
  if (candidateRows.length === 0) return null;
  const runId = candidateRows[0].id;

  // Re-assert the whole predicate inside the UPDATE. Between the SELECT above
  // and this statement another poller may have claimed the run, or the browser
  // that owns it may have come back to life and heartbeated.
  const claim = await sql
    .prepare(
      `UPDATE migration_runs SET last_activity_at = ?
       WHERE id = ? AND status = 'RUNNING'
         AND COALESCE(last_activity_at, started_at) < ?
         AND (commit_started_at IS NULL OR commit_started_at < ?)`
    )
    .bindParams(nowSqlDateTime(), runId, cutoffStr, cutoffStr)
    .execute();

  const affectedRows = (claim.rows as unknown as { affectedRows: number }).affectedRows;
  if (affectedRows !== 1) return null;

  return getMigrationRun(runId);
}

/**
 * Lists RUNNING runs across ALL issues that have been idle longer than
 * `staleThresholdMs`. Used only by the hourly abandoned-run sweep, which is
 * the backstop for runs whose user never returned to the issue (the
 * browser-side recovery above only fires while someone is looking at it).
 */
export async function listStaleRunningRuns(
  staleThresholdMs: number,
  limit: number
): Promise<MigrationRun[]> {
  await ensureSchema();
  const cutoffStr = toSqlDateTime(new Date(Date.now() - staleThresholdMs));
  // Interpolated rather than bound: a placeholder in LIMIT is not portable
  // across every prepared-statement path, and the elsewhere-in-this-file
  // convention is a literal (see listMigrationRuns' LIMIT 50). Coerced to a
  // positive integer so it can never carry anything but a number.
  const safeLimit = Math.max(1, Math.floor(limit));

  const result = await sql
    .prepare(
      `SELECT * FROM migration_runs
       WHERE status = 'RUNNING'
         AND COALESCE(last_activity_at, started_at) < ?
         AND (commit_started_at IS NULL OR commit_started_at < ?)
       ORDER BY started_at ASC
       LIMIT ${safeLimit}`
    )
    .bindParams(cutoffStr, cutoffStr)
    .execute();

  const rows = result.rows as unknown as MigrationRunRow[];
  const runs: MigrationRun[] = [];
  for (const row of rows) {
    runs.push(toMigrationRun(row, await fetchItems(row.id)));
  }
  return runs;
}

/**
 * Bumps the `last_activity_at` timestamp on a migration run to "now". Called
 * whenever an item changes state and periodically during the commit phase, so
 * the stale-run detector can tell whether anyone is still driving this run.
 */
export async function touchRunActivity(migrationId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare('UPDATE migration_runs SET last_activity_at = ? WHERE id = ?')
    .bindParams(nowSqlDateTime(), migrationId)
    .execute();
}

/**
 * Attempts to take the commit lease on a run — the mutual exclusion that makes
 * commitMigrationRun safe to call concurrently. Returns true only for the
 * caller that wins; every other caller gets false and must not commit.
 *
 * This is what prevents the duplicate-attachment failure mode: two commits
 * racing on the same run each observe every item as STAGED, each run
 * planCommit → 'persist', and each insert a full set of attachment rows for
 * the same files while both delete the native Jira copies.
 *
 * An existing lease older than `leaseMs` is stolen, on the assumption its
 * holder's container died — otherwise a crashed commit would wedge the run
 * permanently. Live commits renew the lease (see renewCommitLease), so a
 * genuinely slow commit is never mistaken for a dead one.
 */
export async function claimCommitLease(migrationId: string, leaseMs: number): Promise<boolean> {
  await ensureSchema();
  const now = nowSqlDateTime();
  const expiryStr = toSqlDateTime(new Date(Date.now() - leaseMs));

  const claim = await sql
    .prepare(
      `UPDATE migration_runs SET commit_started_at = ?, last_activity_at = ?
       WHERE id = ? AND (commit_started_at IS NULL OR commit_started_at < ?)`
    )
    .bindParams(now, now, migrationId, expiryStr)
    .execute();

  return (claim.rows as unknown as { affectedRows: number }).affectedRows === 1;
}

/** Extends a held commit lease and heartbeats the run. Called as the commit progresses. */
export async function renewCommitLease(migrationId: string): Promise<void> {
  await ensureSchema();
  const now = nowSqlDateTime();
  await sql
    .prepare('UPDATE migration_runs SET commit_started_at = ?, last_activity_at = ? WHERE id = ?')
    .bindParams(now, now, migrationId)
    .execute();
}

/**
 * Releases the commit lease. Always called in a `finally`, so a commit that
 * throws does not hold the lease until it expires — the user's Retry should
 * work immediately, not two lease-lengths later.
 */
export async function releaseCommitLease(migrationId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare('UPDATE migration_runs SET commit_started_at = NULL WHERE id = ?')
    .bindParams(migrationId)
    .execute();
}
