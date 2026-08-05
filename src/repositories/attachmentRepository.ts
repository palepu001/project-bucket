import { sql } from '@forge/sql';
import { ensureSchema } from '../db/client';
import {
  Attachment,
  AttachmentSource,
  AttachmentStatus,
  AttachmentSyncStatus,
  AttachmentThumbnailStatus,
} from '../types/attachment';

interface AttachmentRow {
  id: string;
  issue_id: string;
  project_id: string;
  filename: string;
  extension: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  object_key: string;
  uploaded_by: string;
  uploaded_at: string;
  last_modified: string;
  status: AttachmentStatus;
  sync_status: AttachmentSyncStatus;
  source: AttachmentSource;
  jira_attachment_id: string | null;
  missing_since: string | null;
  thumbnail_key: string | null;
  thumbnail_status: AttachmentThumbnailStatus | null;
  project_key: string | null;
  issue_key: string | null;
  epic_key: string | null;
  storage_bucket: string | null;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    issueId: row.issue_id,
    projectId: row.project_id,
    filename: row.filename,
    extension: row.extension,
    mimeType: row.mime_type,
    size: Number(row.size_bytes),
    checksum: row.checksum,
    objectKey: row.object_key,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    lastModified: row.last_modified,
    status: row.status,
    // Older rows created before the sync_status column existed read back as
    // undefined until the migration backfill applies; treat them as READY.
    syncStatus: row.sync_status ?? 'READY',
    source: row.source,
    jiraAttachmentId: row.jira_attachment_id,
    // Older rows created before the column existed read back undefined; treat
    // as "never missed" (null).
    missingSince: row.missing_since ?? null,
    // Both stay null for rows predating the thumbnail feature and for migrated
    // attachments — null means "not attempted yet", which is what makes the
    // gallery's lazy backfill kick in.
    thumbnailKey: row.thumbnail_key ?? null,
    thumbnailStatus: row.thumbnail_status ?? null,
    projectKey: row.project_key ?? null,
    issueKey: row.issue_key ?? null,
    epicKey: row.epic_key ?? null,
    storageBucket: row.storage_bucket ?? null,
  };
}

export interface ListAttachmentsParams {
  issueId: string;
  search?: string;
  extension?: string;
  // Diagnostics (storage audit) also needs the quarantined rows so an admin
  // can still see what was lost; the gallery never sets this.
  includeOrphaned?: boolean;
}

export async function listAttachments(params: ListAttachmentsParams): Promise<Attachment[]> {
  await ensureSchema();
  const clauses = [
    'issue_id = ?',
    params.includeOrphaned ? "status IN ('ACTIVE', 'ORPHANED')" : "status = 'ACTIVE'",
  ];
  const values: (string | number)[] = [params.issueId];

  if (params.search && params.search.trim().length > 0) {
    // Matches by filename substring OR exact extension, per the spec's
    // "Search by filename / extension" — a search of "png" should surface
    // both "png-export.zip" (filename match) and every screenshot.png.
    clauses.push('(filename LIKE ? OR extension = ?)');
    const term = params.search.trim();
    values.push(`%${term}%`, term.toLowerCase().replace(/^\./, ''));
  }
  if (params.extension) {
    clauses.push('extension = ?');
    values.push(params.extension.toLowerCase());
  }

  const query = `SELECT * FROM attachments WHERE ${clauses.join(' AND ')} ORDER BY uploaded_at DESC`;
  const result = await sql.prepare(query).bindParams(...values).execute();
  return (result.rows as unknown as AttachmentRow[]).map(toAttachment);
}

export async function getAttachmentById(id: string): Promise<Attachment | null> {
  await ensureSchema();
  const result = await sql
    .prepare("SELECT * FROM attachments WHERE id = ? AND status = 'ACTIVE'")
    .bindParams(id)
    .execute();
  const rows = result.rows as unknown as AttachmentRow[];
  return rows.length > 0 ? toAttachment(rows[0]) : null;
}

const INSERT_COLUMNS = `(id, issue_id, project_id, filename, extension, mime_type, size_bytes, checksum,
         object_key, uploaded_by, uploaded_at, last_modified, status, sync_status, source, jira_attachment_id,
         thumbnail_key, thumbnail_status, project_key, issue_key, epic_key, storage_bucket)`;

const INSERT_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function insertParamsOf(attachment: Attachment): unknown[] {
  return [
    attachment.id,
    attachment.issueId,
    attachment.projectId,
    attachment.filename,
    attachment.extension,
    attachment.mimeType,
    attachment.size,
    attachment.checksum,
    attachment.objectKey,
    attachment.uploadedBy,
    attachment.uploadedAt,
    attachment.lastModified,
    attachment.status,
    attachment.syncStatus,
    attachment.source,
    attachment.jiraAttachmentId,
    attachment.thumbnailKey ?? null,
    attachment.thumbnailStatus ?? null,
    attachment.projectKey ?? null,
    attachment.issueKey ?? null,
    attachment.epicKey ?? null,
    attachment.storageBucket ?? null,
  ];
}

/**
 * Persist a whole upload's attachments in ONE statement.
 *
 * The upload-session invariant is "1 upload action = 1 session = 1 transaction",
 * and @forge/sql exposes no BEGIN/COMMIT — only prepare/execute. A single
 * multi-row INSERT is therefore how that invariant is actually enforced here:
 * MySQL applies one statement atomically, so a whole upload either lands or
 * none of it does. Never replace this with a loop of insertAttachment calls;
 * that reintroduces the partial-commit window this exists to close.
 */
export async function insertAttachments(attachments: Attachment[]): Promise<void> {
  if (attachments.length === 0) return;
  await ensureSchema();
  const values = attachments.map(() => INSERT_PLACEHOLDERS).join(', ');
  await sql
    .prepare(`INSERT INTO attachments ${INSERT_COLUMNS} VALUES ${values}`)
    .bindParams(...attachments.flatMap(insertParamsOf))
    .execute();
}

export async function insertAttachment(attachment: Attachment): Promise<void> {
  await insertAttachments([attachment]);
}

// Attach a generated preview image to an already-persisted attachment, or
// record why one could not be produced. Called by the gallery's lazy backfill
// for rows that predate the thumbnail feature and for migrated attachments,
// which never pass through the upload path's generation step.
export async function updateThumbnail(
  id: string,
  thumbnailKey: string | null,
  thumbnailStatus: AttachmentThumbnailStatus
): Promise<void> {
  await ensureSchema();
  await sql
    .prepare('UPDATE attachments SET thumbnail_key = ?, thumbnail_status = ? WHERE id = ?')
    .bindParams(thumbnailKey, thumbnailStatus, id)
    .execute();
}

// Flip only the health/processing status of an already-persisted attachment.
// Used by the migration pipeline to mark SYNC_ERROR when the native Jira copy
// could not be deleted — the file itself stays untouched and fully usable.
export async function updateSyncStatus(id: string, syncStatus: AttachmentSyncStatus): Promise<void> {
  await ensureSchema();
  await sql.prepare('UPDATE attachments SET sync_status = ? WHERE id = ?').bindParams(syncStatus, id).execute();
}

// Site-wide listing for the hourly consistency sweep. Keyset-paginated by id
// so that rows beyond the first page are checked in subsequent calls within
// the same sweep invocation, and across sweep invocations if the run is capped.
export async function listAllActiveAttachments(
  limit = 500,
  afterId?: string
): Promise<Attachment[]> {
  await ensureSchema();
  const query = afterId
    ? `SELECT * FROM attachments WHERE status = 'ACTIVE' AND id > ? ORDER BY id LIMIT ${Math.floor(limit)}`
    : `SELECT * FROM attachments WHERE status = 'ACTIVE' ORDER BY id LIMIT ${Math.floor(limit)}`;
  const params = afterId ? [afterId] : [];
  const result = await sql.prepare(query).bindParams(...params).execute();
  return (result.rows as unknown as AttachmentRow[]).map(toAttachment);
}

// Records the first consistency sweep at which a row's bytes were found
// missing (the "first strike"). Only sets the marker when it is currently null
// and the row is still ACTIVE, so a genuine quarantine below is always preceded
// by exactly one recorded miss and a re-strike cannot reset the clock.
export async function markFirstMiss(id: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare("UPDATE attachments SET missing_since = ? WHERE id = ? AND missing_since IS NULL AND status = 'ACTIVE'")
    .bindParams(new Date().toISOString(), id)
    .execute();
}

// Clears the first-strike marker when a row's bytes reappear, so a since-healed
// blip can never contribute to a later quarantine.
export async function clearMissing(id: string): Promise<void> {
  await ensureSchema();
  await sql.prepare('UPDATE attachments SET missing_since = NULL WHERE id = ?').bindParams(id).execute();
}

// Quarantines a row whose bytes are confirmed gone from the storage location
// (missing across two consecutive sweeps). The row survives as the audit trail
// of the loss (visible via getStorageAudit); only ACTIVE rows are eligible so a
// concurrent delete cannot be resurrected.
export async function markOrphaned(id: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare("UPDATE attachments SET status = 'ORPHANED' WHERE id = ? AND status = 'ACTIVE'")
    .bindParams(id)
    .execute();
}

export async function deleteAttachmentRow(id: string): Promise<void> {
  await ensureSchema();
  await sql.prepare('DELETE FROM attachments WHERE id = ?').bindParams(id).execute();
}

/**
 * Returns the set of native Jira attachment IDs that have ALREADY been migrated
 * into Project Bucket for this issue. Used by the sweep in pollPendingSession
 * and the dedup guard in migrateSessionOnBackend to avoid re-offering or
 * re-uploading files that are already safely stored.
 *
 * Only considers ACTIVE rows (not DELETED or ORPHANED) because a soft-deleted
 * attachment should not block re-migration if the user somehow re-uploads the
 * same native file after removing it from Project Bucket.
 */
export async function getMigratedJiraAttachmentIds(issueId: string): Promise<Set<string>> {
  await ensureSchema();
  const result = await sql
    .prepare(
      "SELECT jira_attachment_id FROM attachments WHERE issue_id = ? AND jira_attachment_id IS NOT NULL AND status = 'ACTIVE'"
    )
    .bindParams(issueId)
    .execute();
  const rows = result.rows as unknown as { jira_attachment_id: string }[];
  return new Set(rows.map((r) => r.jira_attachment_id));
}
