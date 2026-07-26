import { migrationRunner, sql } from '@forge/sql';

// Every statement is CREATE TABLE IF NOT EXISTS, so re-running this set (the
// hourly scheduledTrigger safety net, or a race at cold start) is always a
// no-op after the first successful run. See src/db/client.ts for how this is
// invoked.

const CREATE_ATTACHMENTS_TABLE = `
CREATE TABLE IF NOT EXISTS attachments (
  id VARCHAR(36) PRIMARY KEY,
  issue_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  filename VARCHAR(500) NOT NULL,
  extension VARCHAR(32) NOT NULL,
  mime_type VARCHAR(200) NOT NULL,
  size_bytes BIGINT NOT NULL,
  checksum VARCHAR(128) NOT NULL,
  object_key VARCHAR(500) NOT NULL,
  uploaded_by VARCHAR(128) NOT NULL,
  uploaded_at DATETIME NOT NULL,
  last_modified DATETIME NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  source VARCHAR(32) NOT NULL,
  jira_attachment_id VARCHAR(64) NULL,
  INDEX idx_attachments_issue (issue_id, status),
  INDEX idx_attachments_project (project_id, status)
)`;

// Added after the initial release: the health/processing status surfaced as
// the attachment's status badge (src/types/attachment.ts AttachmentSyncStatus).
// Kept separate from the ACTIVE/DELETED lifecycle `status` column above.
// Backfills existing rows to 'READY' via the column default.
const ADD_ATTACHMENTS_SYNC_STATUS = `
ALTER TABLE attachments
  ADD COLUMN sync_status VARCHAR(16) NOT NULL DEFAULT 'READY'`;

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS attachment_sessions (
  id VARCHAR(36) PRIMARY KEY,
  issue_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  created_at DATETIME NOT NULL,
  last_event_at DATETIME NOT NULL,
  notified_at DATETIME NULL,
  resolved_at DATETIME NULL,
  INDEX idx_sessions_issue_status (issue_id, status)
)`;

const CREATE_SESSION_ITEMS_TABLE = `
CREATE TABLE IF NOT EXISTS attachment_session_items (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  jira_attachment_id VARCHAR(64) NOT NULL,
  filename VARCHAR(500) NOT NULL,
  size_bytes BIGINT NOT NULL,
  mime_type VARCHAR(200) NOT NULL,
  author_account_id VARCHAR(128) NOT NULL,
  detected_at DATETIME NOT NULL,
  INDEX idx_session_items_session (session_id),
  UNIQUE KEY uq_session_attachment (session_id, jira_attachment_id)
)`;

const CREATE_MIGRATION_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_runs (
  id VARCHAR(36) PRIMARY KEY,
  issue_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(36) NULL,
  requested_count INT NOT NULL,
  migrated_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL,
  started_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  triggered_by VARCHAR(128) NOT NULL,
  INDEX idx_migration_runs_issue (issue_id)
)`;

const CREATE_MIGRATION_ITEMS_TABLE = `
CREATE TABLE IF NOT EXISTS migration_items (
  id VARCHAR(36) PRIMARY KEY,
  migration_id VARCHAR(36) NOT NULL,
  jira_attachment_id VARCHAR(64) NOT NULL,
  filename VARCHAR(500) NOT NULL,
  status VARCHAR(32) NOT NULL,
  error_message TEXT NULL,
  attachment_id VARCHAR(36) NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  INDEX idx_migration_items_migration (migration_id)
)`;

// Added with the two-phase (stage → commit) migration flow. A migration item
// is now STAGED — its bytes verified in storage backend — well before the session
// commits, and the commit step (which persists metadata and deletes the native
// Jira copy for the WHOLE session at once) needs to recover each staged item's
// object key + verified metadata. These columns carry that staged state across
// the separate resolver calls; they stay NULL until the item reaches STAGED.
const ADD_MIGRATION_ITEMS_STAGING = `
ALTER TABLE migration_items
  ADD COLUMN object_key VARCHAR(500) NULL,
  ADD COLUMN mime_type VARCHAR(200) NULL,
  ADD COLUMN size_bytes BIGINT NULL,
  ADD COLUMN checksum VARCHAR(128) NULL`;

// F7 — Teamwork Graph connections. One row per connection the admin creates
// under Apps > Connected apps > Project Bucket > Connections. The connectionId
// is required by every Teamwork Graph SDK call (setObjects, mapUsers, ...), so
// publishing is only possible while a row exists here. Deleting a connection
// removes the row; Atlassian deletes the ingested graph data on its side.
const CREATE_GRAPH_CONNECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS graph_connections (
  connection_id VARCHAR(128) PRIMARY KEY,
  name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
)`;

// F7 hardening — a graph delete that fails (network blip, disconnected
// connector) must not leave ghost metadata in Teamwork Graph forever. Failed
// deletes queue here and the reconciliation sweep drains the queue on its
// next run. Rows exist only between a failed delete and its successful retry.
const CREATE_GRAPH_DELETE_OUTBOX_TABLE = `
CREATE TABLE IF NOT EXISTS graph_delete_outbox (
  attachment_id VARCHAR(36) PRIMARY KEY,
  created_at DATETIME NOT NULL
)`;

// The reconciliation sweep's root task id must be reused across
// scheduleOrUpdateTask calls (per the orchestration docs) to avoid duplicate
// schedules — persist it alongside the connection it belongs to.
const ADD_GRAPH_CONNECTIONS_TASK_ID = `
ALTER TABLE graph_connections
  ADD COLUMN task_id VARCHAR(64) NULL`;

// Two-strike quarantine marker: the timestamp of the first consistency sweep
// that found a row's bytes missing. The sweep quarantines (ACTIVE → ORPHANED)
// only on a second consecutive miss, so one transient/regressed existence check
// can no longer mass-quarantine a live library. NULL = bytes were present.
const ADD_ATTACHMENTS_MISSING_SINCE = `
ALTER TABLE attachments
  ADD COLUMN missing_since DATETIME NULL`;

// Rendered preview image for an attachment, generated in the browser at upload
// time and stored as an ordinary object through the same storage contract as
// the file itself. `thumbnail_key` is an opaque adapter handle exactly like
// `object_key`. Both columns stay NULL for rows that predate this feature and
// for migrated attachments; the gallery fills them in lazily on first view.
const ADD_ATTACHMENTS_THUMBNAIL = `
ALTER TABLE attachments
  ADD COLUMN thumbnail_key VARCHAR(500) NULL,
  ADD COLUMN thumbnail_status VARCHAR(16) NULL`;

// S3 Migration columns. To support building deterministic object keys for S3
// and routing between Instance/Project buckets, we need these additional properties.
//
// NOT run through migrationRunner.enqueue like the migrations above. The
// runner checkpoints a migration by running its DDL and then, in a SEPARATE
// round-trip, inserting a row into __migrations — so a container that dies
// (or a request that times out) between those two calls leaves the ALTER
// applied with no checkpoint recorded. The runner keys strictly on name, so
// every subsequent run() re-issues the same ALTER ... ADD COLUMN against
// columns that already exist, which MySQL rejects as "Duplicate column
// name". That name can then never succeed again through the normal path.
// This happened to v013 in production. reconcileAttachmentsStorageKeys below
// replaces it with an idempotent check (only add columns that are actually
// missing) and writes the SAME checkpoint row the runner would have, so
// tooling that lists __migrations still sees v013_add_attachments_storage_keys
// as applied.
const ATTACHMENTS_STORAGE_KEY_COLUMNS: { name: string; addColumnDdl: string }[] = [
  { name: 'project_key', addColumnDdl: 'ALTER TABLE attachments ADD COLUMN project_key VARCHAR(255) NULL' },
  { name: 'issue_key', addColumnDdl: 'ALTER TABLE attachments ADD COLUMN issue_key VARCHAR(255) NULL' },
  { name: 'epic_key', addColumnDdl: 'ALTER TABLE attachments ADD COLUMN epic_key VARCHAR(255) NULL' },
  { name: 'storage_bucket', addColumnDdl: 'ALTER TABLE attachments ADD COLUMN storage_bucket VARCHAR(255) NULL' },
];
const V013_MIGRATION_NAME = 'v013_add_attachments_storage_keys';

// Carries the preview rendition a migration client generates from the Jira
// bytes across the stage → commit boundary. Without these the client uploaded a
// thumbnail, handed back its key, and the commit dropped it on the floor —
// leaving an unreferenced object in the bucket forever and forcing the gallery
// to re-render the same image through the backfill path.
const MIGRATION_ITEM_THUMBNAIL_COLUMNS: { name: string; addColumnDdl: string }[] = [
  { name: 'thumbnail_key', addColumnDdl: 'ALTER TABLE migration_items ADD COLUMN thumbnail_key VARCHAR(500) NULL' },
  { name: 'thumbnail_status', addColumnDdl: 'ALTER TABLE migration_items ADD COLUMN thumbnail_status VARCHAR(16) NULL' },
];
const V014_MIGRATION_NAME = 'v014_add_migration_items_thumbnail';

/**
 * Idempotent ALTER ... ADD COLUMN, checkpointed exactly like migrationRunner
 * would. Used INSTEAD of migrationRunner.enqueue for every column addition —
 * see the v013 note above for why the runner's two-round-trip checkpoint can
 * permanently wedge an ALTER-based migration.
 */
async function reconcileAddedColumns(
  migrationName: string,
  table: string,
  columns: { name: string; addColumnDdl: string }[]
): Promise<void> {
  const checkpoint = await sql
    .prepare('SELECT 1 FROM __migrations WHERE name = ?')
    .bindParams(migrationName)
    .execute();
  if ((checkpoint.rows as unknown[]).length > 0) return;

  const existingColumns = await sql.executeDDL(`SHOW COLUMNS FROM ${table}`);
  const existingNames = new Set((existingColumns.rows as { Field: string }[]).map((row) => row.Field));

  for (const column of columns) {
    if (existingNames.has(column.name)) continue;
    try {
      await sql.executeDDL(column.addColumnDdl);
    } catch (error) {
      // Another concurrent invocation may have added it between our SHOW
      // COLUMNS read and this ALTER — that race is harmless, not a wedge.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Duplicate column')) throw error;
    }
  }

  await sql.prepare('INSERT INTO __migrations (name) VALUES (?)').bindParams(migrationName).execute();
}

const migrations = migrationRunner
  .enqueue('v001_create_attachments_table', CREATE_ATTACHMENTS_TABLE)
  .enqueue('v002_create_attachment_sessions_table', CREATE_SESSIONS_TABLE)
  .enqueue('v003_create_attachment_session_items_table', CREATE_SESSION_ITEMS_TABLE)
  .enqueue('v004_create_migration_runs_table', CREATE_MIGRATION_RUNS_TABLE)
  .enqueue('v005_create_migration_items_table', CREATE_MIGRATION_ITEMS_TABLE)
  .enqueue('v006_add_attachments_sync_status', ADD_ATTACHMENTS_SYNC_STATUS)
  .enqueue('v007_add_migration_items_staging', ADD_MIGRATION_ITEMS_STAGING)
  .enqueue('v008_create_graph_connections_table', CREATE_GRAPH_CONNECTIONS_TABLE)
  .enqueue('v009_create_graph_delete_outbox_table', CREATE_GRAPH_DELETE_OUTBOX_TABLE)
  .enqueue('v010_add_graph_connections_task_id', ADD_GRAPH_CONNECTIONS_TASK_ID)
  .enqueue('v011_add_attachments_missing_since', ADD_ATTACHMENTS_MISSING_SINCE)
  .enqueue('v012_add_attachments_thumbnail', ADD_ATTACHMENTS_THUMBNAIL);

export async function applySchemaMigrations(): Promise<void> {
  await migrations.run();
  await reconcileAddedColumns(V013_MIGRATION_NAME, 'attachments', ATTACHMENTS_STORAGE_KEY_COLUMNS);
  await reconcileAddedColumns(V014_MIGRATION_NAME, 'migration_items', MIGRATION_ITEM_THUMBNAIL_COLUMNS);
}
