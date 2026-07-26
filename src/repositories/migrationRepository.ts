import { randomUUID } from 'crypto';
import { sql } from '@forge/sql';
import { ensureSchema } from '../db/client';
import { nowSqlDateTime, sqlDateTimeToIso } from '../db/time';
import { MigrationItem, MigrationItemStatus, MigrationRun, MigrationRunStatus } from '../types/migration';

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
        (id, issue_id, project_id, session_id, requested_count, migrated_count, failed_count, status, started_at, triggered_by)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'RUNNING', ?, ?)`
    )
    .bindParams(id, params.issueId, params.projectId, params.sessionId, params.items.length, now, params.triggeredBy)
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
  await sql
    .prepare(
      'UPDATE migration_runs SET status = ?, migrated_count = ?, failed_count = ?, completed_at = ? WHERE id = ?'
    )
    .bindParams(status, migratedCount, failedCount, nowSqlDateTime(), migrationId)
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
           object_key = NULL, mime_type = NULL, size_bytes = NULL, checksum = NULL
       WHERE migration_id = ? AND id IN (${placeholders})`
    )
    .bindParams(migrationId, ...itemIds)
    .execute();
}

/** Re-opens a terminal run (FAILED or PARTIAL_FAILURE) so its commit can be retried. */
export async function reopenRun(migrationId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare("UPDATE migration_runs SET status = 'RUNNING', completed_at = NULL WHERE id = ?")
    .bindParams(migrationId)
    .execute();
}
