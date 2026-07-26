import { sql } from '@forge/sql';
import { ensureSchema } from '../db/client';
import { nowSqlDateTime, sqlDateTimeToIso } from '../db/time';
import { GraphConnection } from '../types/graph';

interface GraphConnectionRow {
  connection_id: string;
  name: string | null;
  created_at: string;
  updated_at: string;
  task_id: string | null;
}

function toGraphConnection(row: GraphConnectionRow): GraphConnection {
  return {
    connectionId: row.connection_id,
    name: row.name,
    createdAt: sqlDateTimeToIso(row.created_at),
    updatedAt: sqlDateTimeToIso(row.updated_at),
    taskId: row.task_id ?? null,
  };
}

export async function upsertConnection(connectionId: string, name: string | null): Promise<void> {
  await ensureSchema();
  const now = nowSqlDateTime();
  await sql
    .prepare(
      `INSERT INTO graph_connections (connection_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = VALUES(updated_at)`
    )
    .bindParams(connectionId, name, now, now)
    .execute();
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare('DELETE FROM graph_connections WHERE connection_id = ?')
    .bindParams(connectionId)
    .execute();
}

// Persists the reconciliation sweep's root task id so later
// scheduleOrUpdateTask calls reuse it instead of creating duplicates.
export async function setConnectionTaskId(connectionId: string, taskId: string): Promise<void> {
  await ensureSchema();
  await sql
    .prepare('UPDATE graph_connections SET task_id = ? WHERE connection_id = ?')
    .bindParams(taskId, connectionId)
    .execute();
}

// The publish pipeline needs *a* connection to ingest through. Admins are not
// expected to create more than one, but if they do, the most recently touched
// one wins deterministically.
export async function getActiveConnection(): Promise<GraphConnection | null> {
  await ensureSchema();
  const result = await sql
    .prepare('SELECT * FROM graph_connections ORDER BY updated_at DESC LIMIT 1')
    .execute();
  const rows = result.rows as unknown as GraphConnectionRow[];
  return rows.length > 0 ? toGraphConnection(rows[0]) : null;
}
