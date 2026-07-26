import { sql } from '@forge/sql';
import { ensureSchema } from '../db/client';
import { nowSqlDateTime } from '../db/time';

// F7 — queue of attachment ids whose Teamwork Graph delete failed and must be
// retried by the reconciliation sweep. See schema.ts for the lifecycle.

export async function enqueueFailedDeletes(attachmentIds: string[]): Promise<void> {
  await ensureSchema();
  const now = nowSqlDateTime();
  for (const attachmentId of attachmentIds) {
    await sql
      .prepare('INSERT IGNORE INTO graph_delete_outbox (attachment_id, created_at) VALUES (?, ?)')
      .bindParams(attachmentId, now)
      .execute();
  }
}

export async function listPendingDeletes(limit = 500): Promise<string[]> {
  await ensureSchema();
  const result = await sql
    .prepare(`SELECT attachment_id FROM graph_delete_outbox ORDER BY created_at LIMIT ${Math.floor(limit)}`)
    .execute();
  return (result.rows as unknown as { attachment_id: string }[]).map((row) => row.attachment_id);
}

export async function clearDeletes(attachmentIds: string[]): Promise<void> {
  await ensureSchema();
  for (const attachmentId of attachmentIds) {
    await sql.prepare('DELETE FROM graph_delete_outbox WHERE attachment_id = ?').bindParams(attachmentId).execute();
  }
}
