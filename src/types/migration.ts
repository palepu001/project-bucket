// Types for bulk-detection sessions and migration diagnostics. See
// src/services/sessionService.ts for how a session accumulates newly
// detected native attachments and src/services/migrationService.ts for how a
// confirmed session becomes a tracked migration run.

export type SessionStatus = 'PENDING' | 'NOTIFIED' | 'RESOLVED' | 'DISMISSED';

export interface SessionItem {
  id: string;
  sessionId: string;
  jiraAttachmentId: string;
  filename: string;
  size: number;
  mimeType: string;
  authorAccountId: string;
  detectedAt: string;
}

export interface Session {
  id: string;
  issueId: string;
  projectId: string;
  status: SessionStatus;
  createdAt: string;
  lastEventAt: string;
  notifiedAt: string | null;
  resolvedAt: string | null;
  items: SessionItem[];
}

// An upload session migrates transactionally, so a run has exactly four
// terminal-or-running states:
//   RUNNING          — staging and/or committing in progress
//   COMPLETED        — every file is in Project Bucket AND its native copy is gone
//   PARTIAL_FAILURE  — every file is safely in Project Bucket, but one or more
//                      native Jira copies could not be deleted (lingering
//                      duplicates). Retryable; retry re-attempts only the
//                      deletions. Nothing was lost.
//   FAILED           — the session was aborted before any native copy was
//                      touched, because at least one file failed to stage.
//                      NOTHING was migrated and every native attachment is
//                      still in Jira. Retryable from the start.
export type MigrationRunStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED';

// Per-item lifecycle. STAGED is the pivotal state that makes the session
// transactional: the bytes are verified in storage backend but the native Jira
// copy has NOT been touched and no attachment metadata has been persisted, so
// a staged item can still be abandoned with zero side effects if a sibling
// item in the same session fails to stage.
//
// SOURCE_MISSING is one of two exits that do NOT abort the session: Jira
// definitively reported the native attachment gone (404, re-verified by the
// backend) — i.e. someone deleted it between detection and "Link All". There
// is nothing left to migrate and nothing to protect, so the item is treated
// as withdrawn from the session and the remaining items commit without it.
//
// BLOCKED is the other. The file failed validation (disallowed extension,
// denied MIME type, or content that does not match its claimed extension), so
// it may not go to the storage location at all. That verdict is PERMANENT —
// a retry re-runs the same checks over the same bytes and reaches the same
// answer — so aborting the session over it would hand the user a popup they
// can never clear and strand every other file in the session in Jira forever.
// The item is withdrawn instead: its native Jira copy is deliberately left in
// place (untouched — nothing is lost, the file simply stays in Jira), the rest
// of the session commits, and diagnostics explains what stayed behind and why.
//
// Anything less definitive (network errors, 5xx, upload/verify failures)
// still becomes FAILED and aborts the whole session.
export type MigrationItemStatus =
  | 'PENDING'
  | 'UPLOADING'
  | 'STAGED'
  | 'SUCCEEDED'
  | 'SOURCE_DELETE_FAILED'
  | 'SOURCE_MISSING'
  | 'BLOCKED'
  | 'FAILED';

export interface MigrationItem {
  id: string;
  migrationId: string;
  jiraAttachmentId: string;
  filename: string;
  status: MigrationItemStatus;
  errorMessage: string | null;
  attachmentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationRun {
  id: string;
  issueId: string;
  projectId: string;
  sessionId: string | null;
  requestedCount: number;
  migratedCount: number;
  failedCount: number;
  status: MigrationRunStatus;
  startedAt: string;
  completedAt: string | null;
  triggeredBy: string;
  items: MigrationItem[];
}
