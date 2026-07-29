import { view, showFlag, events, Modal } from '@forge/bridge';
import { pollPendingSession, dismissSession, beginMigration, runMigration, retryMigration } from './migrationClient';
import { MigrationRun, Session, SessionItem } from './types';

// ---------------------------------------------------------------------------
// Project Bucket attachment watcher.
//
// Loaded by jira:issueViewBackgroundScript — an invisible iframe that runs
// on every issue view, independent of whether the Project Bucket panel is
// expanded. Its whole job is bulk-detection: poll the backend for a
// "quiet" burst of newly created native Jira attachments on THIS issue, and
// when one shows up, present exactly one grouped popup — never one popup per
// attachment.
//
// Why polling: Forge does not give apps an explicit "the user clicked Save"
// event. The only signal available is the `avi:jira:created:attachment`
// product trigger, which fires once per attachment, independently, the
// instant each one is created. The backend accumulates those into a
// per-issue session (services/sessionService.ts) and this script polls for
// the moment that session goes quiet (see QUIET_WINDOW_MS there) — polling
// is simply what "wait for a burst to settle, then act once" has to look
// like on a platform with no server-push and no save-boundary event.
//
// Why this can't double-pop: the claim in pollPendingSession is an atomic
// SQL compare-and-swap (UPDATE ... WHERE status = 'PENDING'); only the one
// poll call that actually flips the row wins it, so even two tabs polling
// the same issue at once cannot both show a popup for the same burst, and a
// session that already resolved or was dismissed never matches the PENDING
// filter again — new attachments after that start an entirely new session.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;

// When Jira tells us the issue just changed (JIRA_ISSUE_CHANGED fires on
// every issue update — including attachment adds and comment saves), the
// burst we're waiting for has very likely just landed. Polling every 500ms
// for a few seconds right then is what makes the popup feel instant after a
// save, without raising the steady-state polling cost for idle issue views.
const FAST_POLL_INTERVAL_MS = 500;
const FAST_POLL_DURATION_MS = 6000;

// Emitted (via the @forge/bridge events API) after a migration changes what
// this issue's attachments look like. The Project Bucket panel listens for it
// and performs the actual refresh — view.refresh() is NOT available inside a
// jira:issueViewBackgroundScript ("this resource's view is not refreshable"),
// but it IS available inside a jira:issuePanel, so the panel refreshes both
// its own gallery and the native issue view on our behalf.
export const ATTACHMENTS_CHANGED_EVENT = 'project-bucket.attachments-changed';

interface WatcherContext {
  issueId: string;
  projectId: string;
}

interface JiraBackgroundScriptContext {
  accountId?: string;
  extension: {
    issue: { id: string; key: string };
    project: { id: string; key: string };
  };
}

let polling = false;
let activeDetectionFlag: { close: () => void } | null = null;
let accumulatedSessions: Session[] = [];

async function pollOnce(context: WatcherContext): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const session = await pollPendingSession(context.issueId);
    // Guard on items being a non-empty array, not just session being truthy.
    // The Forge resolver bridge does not reliably round-trip a `null` return
    // value — pollPendingSession's backend returns null when there is no
    // pending session, but it can come back over the wire as `{}`, which is
    // truthy but has no `items`.
    if (session && Array.isArray(session.items) && session.items.length > 0) {
      await presentDetectionPopup(context, session);
    }
  } catch (error) {
    console.error('[ProjectBucket] Failed to poll for a pending attachment session:', error);
  } finally {
    polling = false;
  }
}

async function presentDetectionPopup(context: WatcherContext, session: Session): Promise<void> {
  // If we already have accumulated sessions, append this one if not already present
  if (!accumulatedSessions.some((s) => s.id === session.id)) {
    accumulatedSessions.push(session);
  }

  // Close the previous flag if one is already open, preventing stacked popups.
  activeDetectionFlag?.close();
  activeDetectionFlag = null;

  // Deduplicate items by jiraAttachmentId to prevent double-counting or double-migrating
  // when multiple sessions are claimed concurrently during a single upload burst
  const uniqueItemsMap = new Map<string, SessionItem>();
  for (const s of accumulatedSessions) {
    for (const item of s.items) {
      uniqueItemsMap.set(item.jiraAttachmentId, item);
    }
  }
  const allItems = Array.from(uniqueItemsMap.values());
  const count = allItems.length;
  const filenames = allItems.map((item) => item.filename).join(', ');
  const title = count === 1 ? '1 new native attachment detected' : `${count} new native attachments detected`;
  const linkActionText = count === 1 ? 'Link to Project Bucket' : 'Link All';

  activeDetectionFlag = await showFlag({
    id: 'pb-session-merged',
    title,
    type: 'info',
    description: `${filenames} — link ${count === 1 ? 'this file' : 'all files'} to Project Bucket?`,
    isAutoDismiss: false,
    actions: [
      {
        text: linkActionText,
        onClick: async () => {
          activeDetectionFlag?.close();
          activeDetectionFlag = null;

          const sessionsToResolve = [...accumulatedSessions];
          accumulatedSessions = []; // clear first to prevent concurrent poll races

          await runMigrationForSessions(context, sessionsToResolve, allItems);
        },
      },
      {
        text: 'Cancel',
        onClick: async () => {
          activeDetectionFlag?.close();
          activeDetectionFlag = null;

          const sessionsToDismiss = [...accumulatedSessions];
          accumulatedSessions = []; // clear first to prevent concurrent poll races

          await Promise.all(
            sessionsToDismiss.map((s) =>
              dismissSession(s.id).catch((error) =>
                console.error('[ProjectBucket] Failed to dismiss session:', error)
              )
            )
          );
        },
      },
    ],
  });
}

async function runMigrationForSessions(
  context: WatcherContext,
  sessions: Session[],
  items: SessionItem[]
): Promise<void> {
  try {
    const primarySession = sessions[0];
    const run = await beginMigration({
      issueId: context.issueId,
      projectId: context.projectId,
      sessionId: primarySession.id,
      items: items.map((item) => ({ jiraAttachmentId: item.jiraAttachmentId, filename: item.filename })),
    });

    // Dismiss the secondary sessions so they are marked as resolved/cleaned up in the DB
    if (sessions.length > 1) {
      await Promise.all(
        sessions.slice(1).map((s) =>
          dismissSession(s.id).catch((error) =>
            console.error('[ProjectBucket] Failed to clean up secondary session during migration:', error)
          )
        )
      );
    }

    const finished = await runMigration(run);
    await presentSummaryFlag(context, finished);
    await maybeRefreshIssueView(finished);
  } catch (error) {
    showFlag({
      id: 'pb-migration-error-merged',
      title: 'Linking to Project Bucket failed',
      type: 'error',
      description: error instanceof Error ? error.message : String(error),
      isAutoDismiss: false,
    });
  }
}

// Renders the outcome of a whole upload session as a single flag, matching the
// three transactional outcomes:
//   COMPLETED       — every file migrated, native copies removed.
//   FAILED          — the session was aborted; NOTHING migrated, every native
//                     attachment left untouched in Jira. Offer a full retry.
//   PARTIAL_FAILURE — every file is safe in Project Bucket, but some native
//                     copies are lingering. Offer a retry that just re-attempts
//                     removing those native copies.
// Names the files whose native Jira source vanished before they could be
// linked (SOURCE_MISSING — e.g. the user deleted the attachment between the
// detection popup and "Link All"). They are withdrawn from the session, not
// failures; the summary just tells the user to double-check those files.
function skippedNote(run: MigrationRun): string {
  const skipped = run.items.filter((item) => item.status === 'SOURCE_MISSING');
  if (skipped.length === 0) return '';
  const names = skipped.map((item) => item.filename).join(', ');
  return skipped.length === 1
    ? ` ${names} was skipped — it was no longer in Jira. Please check that file if you still need it.`
    : ` ${skipped.length} files were skipped — they were no longer in Jira: ${names}. Please check those files if you still need them.`;
}

// Names the files that failed validation and were therefore NOT moved. This has
// to be said out loud: the run still reports success, the file is silently
// absent from Project Bucket, and the only reason nothing was lost is that we
// deliberately left the native Jira copy in place. The user needs to know which
// files those are and that they are still in Jira.
function blockedNote(run: MigrationRun): string {
  const blocked = run.items.filter((item) => item.status === 'BLOCKED');
  if (blocked.length === 0) return '';
  const names = blocked.map((item) => item.filename).join(', ');
  return blocked.length === 1
    ? ` ${names} was not moved — its file type is not allowed in Project Bucket. It is still attached to this issue in Jira.`
    : ` ${blocked.length} files were not moved — their file types are not allowed in Project Bucket: ${names}. They are still attached to this issue in Jira.`;
}

// Tracks the current summary flag so the retry action can close it before
// presenting the updated result. Without this, Forge would stack two flags
// (the old one and the new one) because showFlag is fire-and-forget.
let activeSummaryFlag: { close: () => void } | null = null;

async function presentSummaryFlag(context: WatcherContext, run: MigrationRun): Promise<void> {
  const retryAction = {
    text: 'Retry',
    onClick: async () => {
      try {
        // Close the current summary flag before showing the retry result,
        // otherwise the old flag and the new one would stack.
        activeSummaryFlag?.close();
        activeSummaryFlag = null;
        const reopened = await retryMigration(run.id);
        // On retry the user has already seen the strict first-pass failure, so
        // sources that are definitively gone (404) are withdrawn rather than
        // failing the session again forever: the surviving files migrate and
        // the missing ones are reported in an OK-only dialog below.
        const retried = await runMigration(reopened, { skipMissingSources: true });
        await presentSummaryFlag(context, retried);
        const missing = retried.items
          .filter((item) => item.status === 'SOURCE_MISSING')
          .map((item) => item.filename);
        if (missing.length > 0) {
          await presentMissingSourcesDialog(missing);
        }
        await maybeRefreshIssueView(retried);
      } catch (error) {
        showFlag({
          id: `pb-retry-error-${run.id}`,
          title: 'Retry failed',
          type: 'error',
          description: error instanceof Error ? error.message : String(error),
          isAutoDismiss: false,
        });
      }
    },
  };

  if (run.status === 'FAILED') {
    const n = run.requestedCount;
    activeSummaryFlag = await showFlag({
      id: `pb-migration-summary-${run.id}`,
      title: 'Migration failed',
      type: 'error',
      description: `Nothing was linked. All ${n} native ${
        n === 1 ? 'attachment was' : 'attachments were'
      } left untouched in Jira — you can retry.`,
      isAutoDismiss: false,
      actions: [retryAction],
    });
    return;
  }

  if (run.status === 'PARTIAL_FAILURE') {
    const lingering = run.items.filter((item) => item.status === 'SOURCE_DELETE_FAILED').length;
    activeSummaryFlag = await showFlag({
      id: `pb-migration-summary-${run.id}`,
      title: 'Linked to Project Bucket, with warnings',
      type: 'warning',
      description: `All ${run.migratedCount} ${
        run.migratedCount === 1 ? 'file is' : 'files are'
      } safe in Project Bucket, but ${lingering} native Jira ${
        lingering === 1 ? 'copy' : 'copies'
      } could not be removed. Retry to remove ${lingering === 1 ? 'it' : 'them'}.${skippedNote(run)}${blockedNote(run)}`,
      isAutoDismiss: false,
      actions: [retryAction],
    });
    return;
  }

  if (run.migratedCount === 0) {
    // COMPLETED with nothing migrated: every item in the session was withdrawn,
    // because its source had already been deleted from Jira or because it
    // failed validation. Nothing was lost either way.
    const note = `${skippedNote(run)}${blockedNote(run)}`.trim();
    activeSummaryFlag = await showFlag({
      id: `pb-migration-summary-${run.id}`,
      title: 'Nothing left to link',
      type: blockedNote(run) ? 'warning' : 'info',
      description: note || 'The detected attachments were already deleted from Jira before linking.',
      isAutoDismiss: false,
    });
    return;
  }

  // A run that left files behind is not an unqualified success, so it neither
  // reads as one nor auto-dismisses before the user can read why.
  const blocked = blockedNote(run);
  activeSummaryFlag = await showFlag({
    id: `pb-migration-summary-${run.id}`,
    title: blocked ? 'Linked to Project Bucket, with exceptions' : 'Linked to Project Bucket',
    type: blocked ? 'warning' : 'success',
    description: `${run.migratedCount} ${
      run.migratedCount === 1 ? 'attachment' : 'attachments'
    } migrated and removed from Jira.${skippedNote(run)}${blocked}`,
    isAutoDismiss: !blocked,
  });
}

// Final step of the migration flow. When at least one attachment migrated, its
// native Jira copy was deleted and a Project Bucket copy now exists, so both
// the native attachment list and the panel gallery are stale. This background
// script cannot refresh anything itself (view.refresh() is unsupported here —
// it throws "this resource's view is not refreshable"), so it broadcasts the
// change and the Project Bucket panel does the refreshing: it re-fetches its
// gallery and calls view.refresh() from its own (refreshable) issue-panel
// context, which makes Jira re-render the native attachment list and
// description without a full page reload. The flags rendered above live on
// the host page, so they survive that refresh.
async function maybeRefreshIssueView(run: MigrationRun): Promise<void> {
  if (run.migratedCount === 0) return;
  try {
    await events.emit(ATTACHMENTS_CHANGED_EVENT, { issueId: run.issueId, migrationId: run.id });
  } catch (error) {
    // A failed refresh only costs the user a manual reload — never data — so
    // we log it rather than surfacing an error over the success flag.
    console.error('[ProjectBucket] Failed to announce the migration to the panel:', error);
  }
}

// ---------------------------------------------------------------------------
// Missing-sources dialog: shown after a RETRY when some items were withdrawn
// because their native Jira attachment no longer exists. This is terminal
// information — there is nothing to retry for those files — so it is a
// prominent centered dialog with a single OK button, not a corner flag.
//
// The Modal API opens this bundle's own resource again in a modal; init()
// detects that mode via the modal context and renders the dialog instead of
// starting the watcher. Background scripts have form on silently unsupported
// bridge APIs (view.refresh), so if the modal cannot open, the same message
// falls back to an OK-only warning flag — the information must still land.
// ---------------------------------------------------------------------------

const MISSING_DIALOG_CONTEXT_KEY = 'missingSourcesDialog';

async function presentMissingSourcesDialog(filenames: string[]): Promise<void> {
  try {
    const modal = new Modal({
      size: 'small',
      context: { [MISSING_DIALOG_CONTEXT_KEY]: { filenames } },
    });
    await modal.open();
  } catch (error) {
    ((..._args: any[]) => {})('[ProjectBucket] Could not open the missing-sources modal, falling back to a flag:', error);
    const flag = await showFlag({
      id: `pb-missing-sources-${Date.now()}`,
      title:
        filenames.length === 1
          ? 'One attachment is missing in Jira'
          : `${filenames.length} attachments are missing in Jira`,
      type: 'warning',
      description: `${filenames.join(', ')} ${
        filenames.length === 1 ? 'is' : 'are'
      } missing in Jira, hence not moved. Please recheck ${
        filenames.length === 1 ? 'its' : 'their'
      } availability.`,
      isAutoDismiss: false,
      actions: [{ text: 'OK', onClick: async () => flag.close() }],
    });
  }
}

// Renders the dialog content when this bundle is opened AS the modal. Plain
// DOM on purpose — this bundle has no React, and the dialog is a heading, a
// file list, and an OK button.
function renderMissingSourcesDialog(filenames: string[]): void {
  document.body.innerHTML = '';
  document.body.style.cssText =
    'margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#172b4d;';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:24px;font-size:14px;';

  const heading = document.createElement('h2');
  heading.textContent = filenames.length === 1 ? 'Attachment missing in Jira' : 'Attachments missing in Jira';
  heading.style.cssText = 'margin:0 0 12px;font-size:16px;';

  const message = document.createElement('p');
  message.textContent =
    filenames.length === 1
      ? 'This attachment is missing in Jira, so it was not moved to Project Bucket. Please recheck its availability:'
      : 'These attachments are missing in Jira, so they were not moved to Project Bucket. Please recheck their availability:';
  message.style.cssText = 'margin:0 0 8px;';

  const list = document.createElement('ul');
  list.style.cssText = 'margin:0 0 16px;padding-left:20px;';
  for (const filename of filenames) {
    const entry = document.createElement('li');
    entry.textContent = filename;
    entry.style.cssText = 'font-weight:600;margin-bottom:2px;word-break:break-all;';
    list.appendChild(entry);
  }

  const note = document.createElement('p');
  note.textContent = 'All other detected attachments were linked. There is nothing left to retry for the files above.';
  note.style.cssText = 'margin:0 0 20px;color:#6b778c;font-size:13px;';

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;';
  const ok = document.createElement('button');
  ok.textContent = 'OK';
  ok.style.cssText =
    'background:#0052cc;color:white;border:none;border-radius:3px;padding:6px 16px;font-size:13px;font-weight:500;cursor:pointer;';
  ok.onclick = () => {
    view.close().catch((error) => console.error('[ProjectBucket] Failed to close the modal:', error));
  };
  actions.appendChild(ok);

  wrap.append(heading, message, list, note, actions);
  document.body.appendChild(wrap);
  ok.focus();
}

// Runs a temporary burst of frequent polls on top of the steady interval.
// Re-triggering while a burst is active just extends it; the single timer
// chain below guarantees at most one fast-poll loop exists at a time.
let fastPollUntil = 0;
let fastPollTimer: ReturnType<typeof setTimeout> | null = null;

function triggerFastPolling(context: WatcherContext): void {
  fastPollUntil = Date.now() + FAST_POLL_DURATION_MS;
  if (fastPollTimer !== null) return;

  const tick = async () => {
    await pollOnce(context);
    if (Date.now() < fastPollUntil) {
      fastPollTimer = setTimeout(tick, FAST_POLL_INTERVAL_MS);
    } else {
      fastPollTimer = null;
    }
  };
  tick();
}

async function init(): Promise<void> {
  const raw = await view.getContext();

  // When this bundle was opened by presentMissingSourcesDialog's Modal, the
  // context carries our dialog payload — render the dialog and skip the
  // watcher entirely.
  const modalPayload = (raw as unknown as { extension?: { modal?: Record<string, unknown> } }).extension?.modal?.[
    MISSING_DIALOG_CONTEXT_KEY
  ] as { filenames?: string[] } | undefined;
  if (modalPayload && Array.isArray(modalPayload.filenames)) {
    renderMissingSourcesDialog(modalPayload.filenames);
    return;
  }

  const ctx = raw as unknown as JiraBackgroundScriptContext;
  if (!ctx.extension?.issue?.id || !ctx.extension?.project?.id) {
    ((..._args: any[]) => {})('[ProjectBucket] attachment-watcher could not resolve issue/project context; polling disabled.');
    return;
  }
  const context: WatcherContext = { issueId: ctx.extension.issue.id, projectId: ctx.extension.project.id };

  pollOnce(context);
  setInterval(() => pollOnce(context), POLL_INTERVAL_MS);

  // Jira notifies issue view modules the moment the issue changes (which
  // includes saving a description/comment with attachments in it). Use that
  // as the cue to poll aggressively for a few seconds so the detection popup
  // appears as soon as the session's quiet window elapses, rather than up to
  // a full steady-state interval later.
  events
    .on('JIRA_ISSUE_CHANGED', () => triggerFastPolling(context))
    .catch((error) => ((..._args: any[]) => {})('[ProjectBucket] Could not subscribe to JIRA_ISSUE_CHANGED:', error));
}

init().catch((error) => {
  console.error('[ProjectBucket] attachment-watcher failed to initialise:', error);
});
