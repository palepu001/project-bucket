import { requestJira, invoke } from '@forge/bridge';
import { sha256Base64 } from './utils/checksum';
import { runWithConcurrency } from './utils/concurrency';
import { MigrationItem, MigrationRun, Session } from './types';
import { generateThumbnail, thumbnailFilenameFor, ThumbnailResult } from './thumbnailService';
import { validateMigratedBlob } from './security/blobValidation';

// Duplicate of static/panel/src/services/migrationClient.ts — see that
// file's header comment for why (independently bundled Custom UI resources,
// small enough that sharing isn't worth cross-package build wiring). Keep
// the two in sync if this changes.

function callResolver<T>(functionKey: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke(functionKey, payload) as Promise<T>;
}

const UPLOAD_CONCURRENCY = 3;

// A thumbnail is best-effort decoration; the migration it is attached to is a
// transaction. Nothing downstream of generateThumbnail is allowed to decide
// whether a session commits, so the wait for one is bounded here rather than in
// any individual renderer. Without this bound a renderer that neither resolves
// nor rejects — pdf.js falling back to a blob: worker that never initialises is
// the observed case — parks stageOne forever, and because runWithConcurrency
// joins on Promise.all, that one item silently strands the entire session:
// no commit, no failure, no flag, and a run left RUNNING in the database.
// Timing out rejects, which the existing catch turns into a FAILED thumbnail,
// so the file still migrates and only its preview is missing.
const THUMBNAIL_TIMEOUT_MS = 30_000;

function withThumbnailTimeout(promise: Promise<ThumbnailResult>): Promise<ThumbnailResult> {
  return new Promise<ThumbnailResult>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Thumbnail generation timed out')), THUMBNAIL_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Hashing has to materialize the WHOLE blob as an ArrayBuffer, which doubles
// that file's memory for the duration. With UPLOAD_CONCURRENCY items in flight
// and a 256 MB ceiling per file, letting those overlap is how the tab runs out
// of memory — the same failure SequentialHashEngine was written to fix on the
// upload path. Serializing just the hash step keeps at most one buffer alive
// while uploads still overlap.
let hashChain: Promise<unknown> = Promise.resolve();
function hashSerially(blob: Blob): Promise<string> {
  const next = hashChain.then(() => sha256Base64(blob));
  // Keep the chain alive even if one hash rejects, or every later hash inherits
  // the rejection and the whole run fails.
  hashChain = next.catch(() => undefined);
  return next;
}

export interface RunMigrationOptions {
  // Retry-only leniency: when true, a definitive 404 downloading an item's
  // content withdraws that item (SOURCE_MISSING, backend re-verified) so the
  // surviving files still migrate. The FIRST attempt keeps this false so a
  // missing source fails the whole session — the user is told nothing moved
  // before anything gets skipped, and chooses to retry knowing that.
  skipMissingSources?: boolean;
}

// PHASE 1 for one item: download from Jira, upload to Object Store, then ask
// the backend to verify + stage it. No native copy is touched here — deletion
// only happens in the whole-session commit below, once every item is staged.
async function stageOne(run: MigrationRun, item: MigrationItem, skipMissingSources: boolean): Promise<void> {
  const migrationId = run.id;
  try {
    const contentResponse = await requestJira(`/rest/api/3/attachment/content/${item.jiraAttachmentId}`);
    if (contentResponse.status === 404) {
      // The native attachment was deleted before it could be linked (e.g. the
      // user removed it between the popup and "Link All").
      if (skipMissingSources) {
        await callResolver('skipMissingMigrationItem', { migrationId, itemId: item.id });
        return;
      }
      throw new Error(`"${item.filename}" is no longer in Jira — it was deleted before it could be linked`);
    }
    if (!contentResponse.ok) {
      throw new Error(`Could not download "${item.filename}" from Jira (HTTP ${contentResponse.status})`);
    }
    const blob = await contentResponse.blob();
    const mimeType = blob.type || 'application/octet-stream';

    // Check the bytes BEFORE anything leaves for the storage location. The
    // backend re-checks what it can when it mints the target, but the
    // magic-number check needs the bytes, which only this side has.
    //
    // A block is reported as BLOCKED, not as a failure: the verdict is
    // permanent, so failing would abort the whole session every time it was
    // retried and strand the other files in Jira forever. The blocked file
    // simply stays in Jira and the rest of the session migrates.
    const validation = await validateMigratedBlob(blob, item.filename, mimeType);
    if (!validation.passed) {
      await callResolver('blockMigrationItem', {
        migrationId,
        itemId: item.id,
        reason: validation.message,
      });
      return;
    }

    const checksum = await hashSerially(blob);

    // Generate thumbnail while we have the blob in memory. A null status means
    // "not attempted yet" — that is what the video/SVG categories return here,
    // because they can only be rendered from a URL at the storage location (see
    // thumbnailService), and it is what makes the gallery backfill finish them.
    let thumbnailPromise: Promise<ThumbnailResult> = Promise.resolve({ blob: null, status: null });
    try {
      thumbnailPromise = generateThumbnail(blob, item.filename, mimeType);
    } catch (e) {
      // safe fallback
    }

    const target = await callResolver<{ objectKey: string; uploadUrl: string; method?: string; headers?: Record<string, string> }>('getMigrationUploadTarget', {
      migrationId,
      itemId: item.id,
      length: blob.size,
      mimeType,
      checksum,
      checksumType: 'SHA256',
    });

    const putResponse = await fetch(target.uploadUrl, { 
      method: target.method || 'PUT', 
      body: blob,
      headers: target.headers || {}
    });
    if (!putResponse.ok) {
      throw new Error(`Upload to storage backend failed for "${item.filename}" (HTTP ${putResponse.status})`);
    }

    let thumbnailKey: string | null = null;
    let thumbnailStatus: ThumbnailResult['status'] = null;
    const thumbnailResult = await withThumbnailTimeout(thumbnailPromise).catch((thumbError): ThumbnailResult => {
      // Named explicitly: a thumbnail failure never fails the file, so without
      // a line here the only symptom is a missing preview with no stated cause.
      console.warn(`[ProjectBucket] thumbnail generation failed for "${item.filename}":`, thumbError);
      // generateThumbnail() never itself rejects — it has its own internal
      // try/catch that always resolves to a verdict, including FAILED. So the
      // only way this .catch() can fire is the timeout above, which means the
      // renderer hung rather than ran and lost — see THUMBNAIL_TIMEOUT_MS. That
      // is a fact about THIS environment (a pdf.js worker that would not
      // initialise in the background script), not about these bytes, so it must
      // NOT be recorded as FAILED: FAILED is a permanent verdict the gallery's
      // backfill never reconsiders. A null status is what makes the panel retry
      // the render in its own working context on first view.
      return { blob: null, status: null };
    });
    thumbnailStatus = thumbnailResult.status;

    if (thumbnailResult.blob) {
      const thumbBlob = thumbnailResult.blob;
      const thumbChecksum = await hashSerially(thumbBlob);
      const [thumbTarget] = await callResolver<any[]>('uploadObjects', {
        objects: [{
          filename: thumbnailFilenameFor(item.filename),
          size: thumbBlob.size,
          mimeType: 'image/jpeg',
          checksum: thumbChecksum
        }],
        issueId: run.issueId,
        projectId: run.projectId
      });

      if (thumbTarget && thumbTarget.success) {
        const thumbResponse = await fetch(thumbTarget.url, {
          method: thumbTarget.method || 'PUT',
          body: thumbBlob,
          headers: thumbTarget.headers || {}
        });
        if (thumbResponse.ok) {
          thumbnailKey = thumbTarget.key;
        } else {
          thumbnailStatus = 'FAILED';
        }
      } else {
        thumbnailStatus = 'FAILED';
      }
    }

    await callResolver('stageMigrationItem', {
      migrationId,
      itemId: item.id,
      objectKey: target.objectKey,
      mimeType,
      size: blob.size,
      checksum,
      thumbnailKey,
      thumbnailStatus,
    });
  } catch (error) {
    // Log the exact error so it appears in the browser's developer console —
    // failMigrationItem swallows it on the backend and nothing else surfaces it.
    console.error(`[ProjectBucket] stageOne failed for "${item.filename}":`, error);
    await callResolver('failMigrationItem', {
      migrationId,
      itemId: item.id,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
  }
}

// Runs the whole upload session: stage every item that still needs staging,
// then hand off to the single backend commit that either migrates the entire
// session or aborts it without deleting anything from Jira. On a retry of a
// PARTIAL_FAILURE run there is nothing left to stage, so this goes straight to
// commit, which re-attempts only the outstanding native deletions.
export async function runMigration(
  run: MigrationRun,
  options: RunMigrationOptions = {}
): Promise<MigrationRun> {
  const toStage = run.items.filter((item) => item.status === 'PENDING');
  console.log(`[ProjectBucket] runMigration: staging ${toStage.length} of ${run.items.length} items for run ${run.id}`);
  await runWithConcurrency(toStage, UPLOAD_CONCURRENCY, (item) =>
    stageOne(run, item, options.skipMissingSources === true)
  );
  console.log('[ProjectBucket] runMigration: all items staged, committing...');
  const result = await callResolver<MigrationRun>('commitMigrationRun', { migrationId: run.id });
  console.log('[ProjectBucket] runMigration: commit result status =', result.status);
  return result;
}

export async function beginMigration(params: {
  issueId: string;
  projectId: string;
  sessionId: string | null;
  items: { jiraAttachmentId: string; filename: string }[];
}): Promise<MigrationRun> {
  return callResolver<MigrationRun>('beginMigration', params);
}

export async function retryMigration(migrationId: string): Promise<MigrationRun> {
  return callResolver<MigrationRun>('retryMigration', { migrationId });
}

export async function dismissSession(sessionId: string): Promise<void> {
  await callResolver('dismissSession', { sessionId });
}

export async function pollPendingSession(issueId: string): Promise<Session | null> {
  return callResolver<Session | null>('pollPendingSession', { issueId });
}

/**
 * Asks the backend whether a stale RUNNING migration exists for this issue.
 * Returns the recovered run (with stuck items reset to PENDING) if one was
 * found, or null if there is nothing to resume. Called by the watcher's poll
 * loop so recovery happens automatically when a customer returns to an issue
 * whose previous "Link All" was interrupted by a tab close or navigation.
 */
export async function recoverStaleMigration(issueId: string): Promise<MigrationRun | null> {
  return callResolver<MigrationRun | null>('recoverStaleMigration', { issueId });
}
