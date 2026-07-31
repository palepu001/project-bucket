import { randomUUID } from 'crypto';
import { graph } from '@forge/teamwork-graph';
import { ensureSchema } from './db/client';
import {
  deleteConnection,
  getActiveConnection,
  setConnectionTaskId,
  upsertConnection,
} from './repositories/graphConnectionRepository';
import * as graphSyncService from './services/graphSyncService';
import * as storageConsistencyService from './services/storageConsistencyService';
import * as migrationService from './services/migrationService';
import { recordDetectedAttachment } from './services/sessionService';

export { handler } from './resolvers';

// ---------------------------------------------------------------------------
// Product trigger — fires once per native Jira attachment creation, site-wide.
// This is the accumulation half of bulk detection: it never shows UI, it
// only appends the new attachment into that issue's open session. The
// attachment-watcher background script (static/attachment-watcher) is the
// one that decides when a burst has gone quiet and shows a popup — see
// services/sessionService.ts for the full explanation.
// ---------------------------------------------------------------------------
interface AttachmentCreatedEvent {
  attachment?: {
    id?: string;
    issueId?: string;
    fileName?: string;
    filename?: string;
    size?: number;
    mimeType?: string;
    author?: { accountId?: string };
  };
}

export const onAttachmentCreated = async (event: AttachmentCreatedEvent): Promise<void> => {
  const attachment = event?.attachment;
  const issueId = attachment?.issueId;
  const attachmentId = attachment?.id;
  const filename = attachment?.fileName ?? attachment?.filename;
  const authorAccountId = attachment?.author?.accountId;

  if (!issueId || !attachmentId || !filename || !authorAccountId) {
    ((..._args: any[]) => {})('[ProjectBucket] Ignoring attachment-created event with missing required fields:', {
      issueId,
      attachmentId,
      filename,
      authorAccountId,
    });
    return;
  }

  try {
    await recordDetectedAttachment({
      issueId,
      jiraAttachmentId: attachmentId,
      filename,
      size: attachment?.size ?? 0,
      mimeType: attachment?.mimeType ?? 'application/octet-stream',
      authorAccountId,
    });
    ((..._args: any[]) => {})('[ProjectBucket] Recorded detected attachment', attachmentId, 'on issue', issueId);
  } catch (error) {
    console.error('[ProjectBucket] Failed to record detected attachment into a session:', error);
  }
};

// ---------------------------------------------------------------------------
// Scheduled trigger — hourly maintenance. Ensures the SQL schema exists (a
// cheap no-op after the first run — see src/db/client.ts) and bootstraps the
// reconciliation sweep for connections that predate sweep scheduling (created
// before this app version, where only a fresh Connect/Update event would
// otherwise schedule it). No-op once the connection has a taskId.
// ---------------------------------------------------------------------------
export const runSchemaMigration = async (): Promise<void> => {
  await ensureSchema();
  const connection = await getActiveConnection();
  if (connection && !connection.taskId) {
    await ensureSweepScheduled(connection.connectionId);
  }
};

// ---------------------------------------------------------------------------
// Scheduled trigger — hourly consistency sweep. Two guarantees, converging
// even for issues nobody opens:
//   1. Storage: every ACTIVE attachment's bytes still exist at the storage
//      location; a row missing across two consecutive sweeps is quarantined
//      (ORPHANED + graph withdrawal). The two-strike rule keeps a transient
//      read from ever mass-quarantining live files.
//   2. Graph: every ACTIVE attachment's metadata is (re)pushed to the
//      Teamwork Graph connector and queued deletes are drained — setObjects
//      upserts, so republishing is idempotent. This is the app-owned check
//      that metadata actually reaches the connector; it runs hourly and does
//      not depend on the platform's 24h orchestration task being scheduled.
//   3. Migrations: runs abandoned mid-flight converge to a terminal state.
//      The whole migration pipeline is driven from the issue view, so a user
//      who starts "Link All" and navigates to another issue leaves a run
//      nothing in the browser will ever return to. This finishes the ones the
//      backend can finish and cleanly aborts the rest — see
//      migrationService.sweepAbandonedRuns.
// The three halves are isolated: a failure in one never blocks the others.
// ---------------------------------------------------------------------------
export const runConsistencySweep = async (): Promise<void> => {
  await ensureSchema();

  try {
    const summary = await storageConsistencyService.runStorageSweep();
    if (summary.orphaned > 0) {
      console.warn(
        `[ProjectBucket] Consistency sweep quarantined ${summary.orphaned} of ${summary.checked} attachment(s) — bytes confirmed missing across two consecutive sweeps`
      );
    }
  } catch (error) {
    console.error('[ProjectBucket] Consistency sweep: storage check failed:', error);
  }

  try {
    await graphSyncService.runReconciliationSweep();
  } catch (error) {
    console.error('[ProjectBucket] Consistency sweep: graph reconciliation failed:', error);
  }

  try {
    const summary = await migrationService.sweepAbandonedRuns();
    if (summary.examined > 0) {
      console.log(
        `[ProjectBucket] Consistency sweep: examined ${summary.examined} abandoned migration run(s) — ` +
          `${summary.committed} completed, ${summary.aborted} aborted, ` +
          `${summary.objectsReclaimed} staged object(s) reclaimed`
      );
    }
    if (summary.needsAttention > 0) {
      console.warn(
        `[ProjectBucket] Consistency sweep: ${summary.needsAttention} half-committed migration run(s) need manual review`
      );
    }
  } catch (error) {
    console.error('[ProjectBucket] Consistency sweep: abandoned migration sweep failed:', error);
  }
};

// ---------------------------------------------------------------------------
// Teamwork Graph connector lifecycle (F7). Invoked by the graph:connector
// module when an admin creates, updates, or deletes the connection under
// Apps > Connected apps > Project Bucket > Connections. The payload shape is
// documented in the Teamwork Graph connector module reference; the platform
// may deliver it either directly or wrapped in a `body` property, so we
// accept both. The stored connectionId is what every SDK ingestion call
// (setObjects, mapUsers, ...) requires, so persisting it here is what turns
// publishing on. On DELETED we only clear local state: Atlassian deletes the
// ingested graph data on its side automatically.
// ---------------------------------------------------------------------------
interface ConnectionChangeEvent {
  action?: 'CREATED' | 'UPDATED' | 'DELETED';
  name?: string;
  connectionId?: string;
  configProperties?: Record<string, string>;
  body?: ConnectionChangeEvent;
}

export const onConnectionChange = async (
  event: ConnectionChangeEvent
): Promise<{ statusCode: number }> => {
  const payload = event?.body ?? event;
  const action = payload?.action;
  const connectionId = payload?.connectionId;
  ((..._args: any[]) => {})(
    '[ProjectBucket] Teamwork Graph connection change:',
    action,
    'connectionId:',
    connectionId
  );

  if (!action || !connectionId) {
    ((..._args: any[]) => {})('[ProjectBucket] Ignoring connection change event with missing fields');
    return { statusCode: 200 };
  }

  try {
    if (action === 'CREATED' || action === 'UPDATED') {
      await upsertConnection(connectionId, payload?.name ?? null);
      await ensureSweepScheduled(connectionId);
    } else if (action === 'DELETED') {
      await deleteConnection(connectionId);
    }
    return { statusCode: 200 };
  } catch (error) {
    console.error('[ProjectBucket] Failed to persist connection change:', error);
    return { statusCode: 500 };
  }
};

// Schedules (or refreshes) the 24-hour reconciliation sweep for a connection.
// The orchestration docs require reusing a stored taskId to avoid duplicate
// schedules. Scheduling failure is logged but never fails the connection
// event — the connection itself is persisted and publishing works without
// the sweep; the next lifecycle event retries the scheduling.
const ensureSweepScheduled = async (connectionId: string): Promise<void> => {
  try {
    const connection = await getActiveConnection();
    const taskId = connection?.taskId ?? randomUUID();
    const response = await graph.scheduleOrUpdateTask({
      connectionId,
      scheduleInterval: { value: 24, timeUnit: 'hours' },
      task: { taskType: 'entity_ingestion_full', taskId },
    });
    await setConnectionTaskId(connectionId, response.taskId ?? taskId);
    ((..._args: any[]) => {})('[ProjectBucket] Reconciliation sweep scheduled, taskId:', response.taskId ?? taskId);
  } catch (error) {
    console.error('[ProjectBucket] Failed to schedule reconciliation sweep:', error);
  }
};

// ---------------------------------------------------------------------------
// F7 — reconciliation sweep runner. The platform invokes this on the schedule
// registered above; every run MUST end with updateTaskStatus (per the
// orchestration docs) so the platform can track/retry runs.
// ---------------------------------------------------------------------------
interface GraphTaskEvent {
  taskId?: string;
  scanId?: string;
  taskExecutionId?: string;
  connectionId?: string;
  body?: GraphTaskEvent;
}

export const onGraphTask = async (event: GraphTaskEvent): Promise<void> => {
  const payload = event?.body ?? event;
  const { taskId, scanId, taskExecutionId, connectionId } = payload ?? {};
  if (!taskId || !scanId || !taskExecutionId || !connectionId) {
    ((..._args: any[]) => {})('[ProjectBucket] Ignoring graph task invocation with missing fields:', payload);
    return;
  }

  let success = false;
  try {
    success = await graphSyncService.runReconciliationSweep();
  } catch (error) {
    console.error('[ProjectBucket] Reconciliation sweep threw:', error);
  }

  await graph.updateTaskStatus({
    connectionId,
    scanId,
    taskExecutionId,
    status: success ? 'success' : 'failure',
    ...(success ? {} : { failureReason: 'RETRYABLE_ERROR' as const }),
    task: { taskId },
  });
};

// ---------------------------------------------------------------------------
// F7 Milestone 7 — event-driven refresh. Any issue update can change what
// "who can see this issue" means (security level set/cleared, issue moved),
// so republish the issue's Project Bucket metadata with freshly resolved
// ACLs. No-ops instantly (one indexed SQL query) for issues without bucket
// attachments, which is the overwhelming majority of update events.
// ---------------------------------------------------------------------------
interface IssueUpdatedEvent {
  issue?: { id?: string };
}

export const onIssueUpdated = async (event: IssueUpdatedEvent): Promise<void> => {
  const issueId = event?.issue?.id;
  if (!issueId) return;
  try {
    await graphSyncService.republishIssue(issueId);
  } catch (error) {
    console.error(`[ProjectBucket] Issue-updated graph refresh failed for ${issueId}:`, error);
  }
};
