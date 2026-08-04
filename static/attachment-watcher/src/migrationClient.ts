import { invoke } from '@forge/bridge';
import { MigrationRun, Session } from './types';

// Duplicate of static/panel/src/services/migrationClient.ts — see that
// file's header comment for why (independently bundled Custom UI resources,
// small enough that sharing isn't worth cross-package build wiring). Keep
// the two in sync if this changes.
//
// NOTE: The browser-side upload pipeline (stageOne, runMigration, hashSerially,
// etc.) has been removed. All Jira→S3 streaming now happens in the backend's
// async worker (onMigrateSessionEvent, 900-second timeout). The watcher's job
// is to trigger migration and poll for results — no file data flows through
// the browser at all.

function callResolver<T>(functionKey: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke(functionKey, payload) as Promise<T>;
}

export async function dismissSession(sessionId: string): Promise<void> {
  await callResolver('dismissSession', { sessionId });
}

export async function pollPendingSession(issueId: string): Promise<Session | null> {
  return callResolver<Session | null>('pollPendingSession', { issueId });
}

/**
 * Kicks off a new migration for the detected upload session. The backend
 * creates the DB run, enqueues an async event, and returns immediately with
 * { runId, status: 'RUNNING' }. Poll getMigrationRunStatus for completion.
 */
export async function migrateSessionOnBackend(params: {
  sessionId: string;
  issueId: string;
  projectId: string;
  items: { jiraAttachmentId: string; filename: string }[];
}): Promise<{ runId: string; status: 'RUNNING' }> {
  return callResolver<{ runId: string; status: 'RUNNING' }>('migrateSessionOnBackend', params);
}

/**
 * Polls the SQL-backed status of a migration run. Call in a loop until status
 * is COMPLETED, FAILED, or PARTIAL_FAILURE.
 */
export async function getMigrationRunStatus(migrationId: string): Promise<MigrationRun | null> {
  return callResolver<MigrationRun | null>('getMigrationRunStatus', { migrationId });
}

/**
 * Retries a FAILED or PARTIAL_FAILURE run via the async worker. Resets items,
 * re-opens the run, enqueues it for the 900-second backend worker, and returns
 * { runId, status: 'RUNNING' }. Poll getMigrationRunStatus for the result.
 */
export async function retryMigrationAsync(migrationId: string): Promise<{ runId: string; status: 'RUNNING' }> {
  return callResolver<{ runId: string; status: 'RUNNING' }>('retryMigrationAsync', { migrationId });
}

/**
 * Asks the backend whether a stale RUNNING migration exists for this issue.
 * If found, the backend claims it, re-queues it on the async worker, and
 * returns { runId, status: 'RUNNING' }. Returns null if there is nothing
 * to recover. The watcher's poll loop then polls getMigrationRunStatus.
 */
export async function recoverStaleMigration(issueId: string): Promise<{ runId: string; status: 'RUNNING' } | null> {
  return callResolver<{ runId: string; status: 'RUNNING' } | null>('recoverStaleMigration', { issueId });
}
