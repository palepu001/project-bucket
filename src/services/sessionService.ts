import * as sessionRepository from '../repositories/sessionRepository';
import { getIssueProjectIdAsApp } from './jiraAttachmentSource';
import { Session } from '../types/migration';

// How long a per-issue attachment burst must stay quiet before we treat it as
// "finished" and show one grouped popup. Forge does not expose an explicit
// "the user clicked Save" event to apps — jira:issueViewBackgroundScript only
// ever sees the product trigger firing once per attachment creation — so a
// debounce window is the mechanism available on this platform for turning
// "N discrete attachment-created events" into "one edit session". The window
// restarts on every event (last_event_at), so it only needs to cover the gap
// BETWEEN two attachments of the same save — which Jira creates near-
// simultaneously — not the whole burst. 800ms keeps one save grouped into one
// popup while making the popup feel immediate after the save lands.
export const QUIET_WINDOW_MS = 800;

/** Called by the `on-attachment-created` trigger for every native attachment created anywhere on the site. */
export async function recordDetectedAttachment(params: {
  issueId: string;
  jiraAttachmentId: string;
  filename: string;
  size: number;
  mimeType: string;
  authorAccountId: string;
}): Promise<void> {
  const projectId = await getIssueProjectIdAsApp(params.issueId);
  await sessionRepository.appendToSession({
    issueId: params.issueId,
    projectId,
    jiraAttachmentId: params.jiraAttachmentId,
    filename: params.filename,
    size: params.size,
    mimeType: params.mimeType,
    authorAccountId: params.authorAccountId,
  });
}

/**
 * Polled by the attachment-watcher every ~2.5s while an issue view is open.
 * Returns a session the instant it has gone quiet, and atomically ensures
 * only one poller (one browser tab) ever receives it — see
 * sessionRepository.claimQuietSession for the compare-and-swap that makes
 * this safe against concurrent pollers without a lock.
 */
export async function pollForNotifiableSession(issueId: string): Promise<Session | null> {
  return sessionRepository.claimQuietSession(issueId, QUIET_WINDOW_MS);
}

export async function dismissSession(sessionId: string): Promise<void> {
  await sessionRepository.markSessionDismissed(sessionId);
}
