import { randomUUID } from 'crypto';
import * as migrationRepository from '../repositories/migrationRepository';
import { StagedMigrationItem as StagedItem } from '../repositories/migrationRepository';
import * as sessionRepository from '../repositories/sessionRepository';
import * as attachmentRepository from '../repositories/attachmentRepository';
import { deleteNativeAttachment, getAttachmentMetadata } from './jiraAttachmentSource';
import * as graphSyncService from './graphSyncService';
import { resolveMediaId, removeMediaReferences } from './jiraContentCleanup';
import { getStorageProvider, ChecksumType } from '../storage';
import { generateStorageKey, StorageKeyContext } from '../util/storageKey';
import api, { route } from '@forge/api';
import { extensionOf } from '../types/attachment';
import { MigrationRun } from '../types/migration';

// Orchestrates the Jira-native → Project Bucket migration of ONE upload
// session as a single transaction. The unit of work is the whole session, not
// the individual attachment: either every file in the session ends up in
// Project Bucket with its native Jira copy removed, or nothing is removed from
// Jira at all. See the F3 product requirement — "never partially migrate an
// upload session".
//
// The actual byte transfer (download the native attachment, PUT it to Forge
// storage backend) can only happen in the browser — see
// services/jiraAttachmentSource.ts for why the backend has no "push these
// bytes into the store" primitive. So the pipeline is split into two phases a
// client (static/attachment-watcher, or the panel's retry action) drives:
//
//   PHASE 1 — STAGE (per item, runs concurrently in the browser)
//     1. beginMigration      — create the tracked run + PENDING items
//     2. getUploadTarget     — mint a presigned URL for one item
//          (client downloads the Jira attachment, then PUTs it to that URL)
//     3. stageMigrationItem  — verify the object landed and record its staged
//          metadata. Crucially, this does NOT persist an attachment and does
//          NOT touch the native Jira copy: a staged item can still be
//          abandoned with zero side effects.
//     ·  failMigrationItem   — record a per-item staging failure (Jira untouched)
//
//   PHASE 2 — COMMIT (whole session, one backend call, only after ALL staged)
//     4. commitMigrationRun  — the transaction boundary:
//          a. if any item failed to stage → ABORT: delete NOTHING from Jira,
//             persist NOTHING, mark the run FAILED. The user keeps every
//             native attachment and can retry.
//          b. otherwise persist metadata for EVERY item, and only then delete
//             EVERY native Jira copy. If a delete fails the file is already
//             safe in Project Bucket, so the run is PARTIAL_FAILURE (a
//             lingering duplicate, retryable) — never a lost file.
//
// Every step writes through to Forge SQL immediately, so the diagnostics
// panel always reflects true in-progress state even if the browser tab
// closes mid-run — nothing is buffered in memory and flushed at the end.

export async function beginMigration(params: {
  issueId: string;
  projectId: string;
  sessionId: string | null;
  triggeredBy: string;
  items: { jiraAttachmentId: string; filename: string }[];
}): Promise<MigrationRun> {
  const run = await migrationRepository.createMigrationRun(params);
  if (params.sessionId) {
    await sessionRepository.markSessionResolved(params.sessionId);
  }
  return run;
}

export async function getUploadTarget(params: {
  migrationId: string;
  itemId: string;
  length: number;
  checksum: string;
  checksumType: ChecksumType;
  cloudId: string;
}): Promise<{ objectKey: string; uploadUrl: string; method?: string; headers?: Record<string, string> }> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error('Migration run not found');
  await migrationRepository.updateMigrationItem(params.itemId, { status: 'UPLOADING', startedAt: true });

  const issueResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${run.issueId}?fields=project,parent`);
  const issueData = await issueResponse.json();
  const storageContext: StorageKeyContext = {
    cloudId: params.cloudId,
    projectKey: issueData.fields.project.key,
    issueKey: issueData.key,
    epicKey: issueData.fields.parent ? issueData.fields.parent.key : null,
  };

  const objectKey = generateStorageKey(storageContext);
  // No TTL — the staged object must persist until the session commits (or is
  // abandoned and explicitly cleaned up), never self-expire underneath us.
  const provider = await getStorageProvider({ projectId: run.projectId });
  const target = await provider.upload({
    ref: objectKey,
    length: params.length,
    checksum: params.checksum,
    checksumType: params.checksumType,
    overwrite: false,
  });
  return { objectKey, uploadUrl: target.url, method: target.method, headers: target.headers };
}

/**
 * PHASE 1 — stage one item. Verifies the freshly uploaded object actually
 * landed in storage backend, then records its verified metadata against the
 * item and marks it STAGED. Deliberately does NOT persist an attachment and
 * does NOT delete the native Jira copy: staging is side-effect-free with
 * respect to Jira, which is what lets the session abort cleanly if a sibling
 * item fails. Throws on a verification mismatch; the client turns that into a
 * failMigrationItem call.
 */
export async function stageMigrationItem(params: {
  migrationId: string;
  itemId: string;
  objectKey: string;
  mimeType: string;
  size: number;
  checksum: string;
}): Promise<{ staged: true }> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error('Migration run not found');
  const provider = await getStorageProvider({ projectId: run.projectId });
  const [check] = await provider.exists([params.objectKey]);
  if (check?.status === 'error') {
    throw new Error(`Transient storage error checking object ${params.objectKey}`);
  }
  const stored = check?.status === 'found' ? check.summary : undefined;
  if (!stored || stored.size !== params.size) {
    const message = stored
      ? `Uploaded object size (${stored.size}) does not match expected size (${params.size})`
      : 'Uploaded object was not found at the storage location';
    await migrationRepository.updateMigrationItem(params.itemId, {
      status: 'FAILED',
      errorMessage: message,
      completedAt: true,
    });
    throw new Error(message);
  }

  await migrationRepository.updateMigrationItem(params.itemId, {
    status: 'STAGED',
    errorMessage: null,
    objectKey: params.objectKey,
    mimeType: params.mimeType,
    size: params.size,
    checksum: params.checksum,
  });
  return { staged: true };
}

export async function failMigrationItem(params: {
  migrationId: string;
  itemId: string;
  error: string;
}): Promise<void> {
  await migrationRepository.updateMigrationItem(params.itemId, {
    status: 'FAILED',
    errorMessage: params.error,
    completedAt: true,
  });
}

/**
 * PHASE 1 alternative ending — the client saw Jira return 404 for an item's
 * content: the native attachment was deleted (typically by the user, between
 * the detection popup and "Link All"). A vanished source is not a staging
 * failure: there is nothing left to migrate and nothing left to protect, so
 * the item becomes SOURCE_MISSING and the rest of the session commits without
 * it. Clients only request this on a RETRY — the first attempt deliberately
 * fails the whole session so the user learns nothing moved before anything is
 * skipped. The 404 is re-verified against Jira here rather than trusted from
 * the browser — a client claim alone must never be able to shrink the
 * transaction. If Jira says the attachment still exists, whatever the client
 * saw was transient and the item FAILS instead, aborting the session as usual.
 */
export async function skipMissingMigrationItem(params: {
  migrationId: string;
  itemId: string;
}): Promise<{ skipped: boolean }> {
  const items = await migrationRepository.getStagedMigrationItems(params.migrationId);
  const item = items.find((candidate) => candidate.id === params.itemId);
  if (!item) throw new Error(`Migration item "${params.itemId}" not found`);

  // Idempotence + terminal-state guard: never rewrite an item that already
  // persisted or already resolved as missing.
  if (item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED' || item.status === 'SOURCE_MISSING') {
    return { skipped: item.status === 'SOURCE_MISSING' };
  }

  const metadata = await getAttachmentMetadata(item.jiraAttachmentId);
  if (metadata !== null) {
    await migrationRepository.updateMigrationItem(params.itemId, {
      status: 'FAILED',
      errorMessage: `Downloading "${item.filename}" failed, but the attachment still exists in Jira`,
      completedAt: true,
    });
    return { skipped: false };
  }

  await migrationRepository.updateMigrationItem(params.itemId, {
    status: 'SOURCE_MISSING',
    errorMessage: 'The native Jira attachment no longer exists — it was deleted before it could be linked',
    completedAt: true,
  });
  return { skipped: true };
}

/**
 * PHASE 2 — the transaction boundary for the whole upload session. Called once,
 * after the client has attempted to stage every item.
 *
 *   • If any item is not STAGED (i.e. one failed to stage), ABORT: persist
 *     nothing, delete nothing from Jira, mark the run FAILED. Every native
 *     attachment stays in Jira and the session can be retried from the start.
 *   • If every item is STAGED (a fresh commit), persist metadata for ALL items
 *     first, then delete ALL native copies. A native-delete failure leaves the
 *     file safe in Project Bucket, so it is a PARTIAL_FAILURE, not a lost file.
 *   • If every item is already persisted (a retry of a PARTIAL_FAILURE run),
 *     just re-attempt the outstanding native deletions.
 */
export async function commitMigrationRun(params: {
  migrationId: string;
  actorAccountId: string;
}): Promise<MigrationRun> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error(`Migration run "${params.migrationId}" not found`);

  const items = await migrationRepository.getStagedMigrationItems(params.migrationId);
  // SOURCE_MISSING items are withdrawn from the transaction — their native
  // source was deleted before staging, so there is nothing to migrate and
  // nothing to protect. The all-or-nothing rule applies to the items whose
  // sources still exist.
  const present = items.filter((item) => item.status !== 'SOURCE_MISSING');
  const allStaged = present.length > 0 && present.every((item) => item.status === 'STAGED');
  const allPersisted =
    present.length > 0 &&
    present.every((item) => item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED');

  if (items.length > 0 && present.length === 0) {
    // Every source in the session vanished before migration. Nothing to do,
    // nothing lost — the session is trivially complete with zero migrations.
    await migrationRepository.setRunFinal(params.migrationId, 'COMPLETED', 0, 0);
  } else if (allStaged) {
    await persistAndDeleteSession(run, present, params.actorAccountId);
  } else if (allPersisted) {
    // Retry of a PARTIAL_FAILURE run: metadata already exists, only the native
    // deletions need re-attempting. Re-run deletion for the lingering copies.
    const lingering = items.filter((item) => item.status === 'SOURCE_DELETE_FAILED');
    await deleteNativeCopiesAndCleanReferences(
      run.issueId,
      lingering.map((item) => ({ item, attachmentId: item.attachmentId! }))
    );
    await finalizeAfterCommit(run);
  } else {
    // At least one item failed to stage (or is still pending). Honour the
    // transaction rule: keep every native attachment, persist nothing.
    await migrationRepository.setRunFinal(params.migrationId, 'FAILED', 0, run.requestedCount);
  }

  const finalRun = await migrationRepository.getMigrationRun(params.migrationId);
  if (!finalRun) throw new Error(`Migration run "${params.migrationId}" disappeared during commit`);
  // F7: after any commit outcome that persisted attachments, republish the
  // whole issue into Teamwork Graph (covers fresh commits AND retries in one
  // line). publishAttachments never throws — a graph hiccup must not turn a
  // successful migration into a failure.
  if (finalRun.status === 'COMPLETED' || finalRun.status === 'PARTIAL_FAILURE') {
    await graphSyncService.republishIssue(finalRun.issueId);
  }
  return finalRun;
}

// Fresh commit of a fully-staged session: persist every attachment, then
// delete every native copy. If persistence itself fails partway (an unexpected
// DB error), roll back the rows we inserted so the session stays all-or-nothing
// and no native copy is ever deleted.
async function persistAndDeleteSession(
  run: MigrationRun,
  items: StagedItem[],
  actorAccountId: string
): Promise<void> {
  // Durability gate: each object was verified when it was staged, but the whole
  // point of the two-phase commit is that the irreversible half (deleting native
  // Jira copies) must never run against bytes that are no longer there. Re-verify
  // every staged object immediately before that half. On any miss, abort the
  // whole session with nothing persisted — every native Jira copy stays exactly
  // where it is, so a storage-location loss can never become permanent loss.
  const stagedKeys = items
    .map((item) => item.objectKey)
    .filter((key): key is string => Boolean(key));
  const provider = await getStorageProvider({ projectId: run.projectId });
  const checks = await provider.exists(stagedKeys);
  if (checks.some((r) => r.status === 'error')) {
    throw new Error('Transient storage error while re-verifying staged keys for commit');
  }
  const storedKeys = new Set(
    checks
      .filter((r) => r.status === 'found')
      .map((r) => r.ref)
  );
  const lost = items.filter((item) => !item.objectKey || !storedKeys.has(item.objectKey));
  if (lost.length > 0) {
    await migrationRepository.setRunFinal(run.id, 'FAILED', 0, run.requestedCount);
    throw new Error(
      `Commit aborted: ${lost.length} staged file(s) are no longer present in storage ` +
        `(${lost.map((item) => item.filename).join(', ')}). ` +
        'Nothing was migrated and no native Jira attachments were deleted; retry re-runs the session.'
    );
  }

  const issueResponse = await api.asApp().requestJira(route`/rest/api/3/issue/${run.issueId}?fields=project,parent`);
  const issueData = await issueResponse.json();
  const hierarchy = {
    projectKey: issueData.fields.project.key,
    issueKey: issueData.key,
    epicKey: issueData.fields.parent ? issueData.fields.parent.key : null,
  };
  
  const persisted: { item: StagedItem; attachmentId: string }[] = [];
  try {
    for (const item of items) {
      const attachmentId = await persistAttachment(run, item, actorAccountId, hierarchy);
      persisted.push({ item, attachmentId });
    }
  } catch (error) {
    for (const { attachmentId } of persisted) {
      await attachmentRepository.deleteAttachmentRow(attachmentId).catch(() => undefined);
    }
    await migrationRepository.setRunFinal(run.id, 'FAILED', 0, run.requestedCount);
    throw error;
  }

  await deleteNativeCopiesAndCleanReferences(run.issueId, persisted);
  await finalizeAfterCommit(run);
}

async function persistAttachment(run: MigrationRun, item: StagedItem, actorAccountId: string, hierarchy: { projectKey: string, issueKey: string, epicKey: string | null }): Promise<string> {
  if (!item.objectKey || item.size === null) {
    throw new Error(`Item "${item.filename}" is missing staged data and cannot be committed`);
  }
  const attachmentId = randomUUID();
  const now = new Date().toISOString();
  await attachmentRepository.insertAttachment({
    id: attachmentId,
    issueId: run.issueId,
    projectId: run.projectId,
    filename: item.filename,
    extension: extensionOf(item.filename),
    mimeType: item.mimeType || 'application/octet-stream',
    size: item.size,
    checksum: item.checksum || '',
    objectKey: item.objectKey,
    uploadedBy: actorAccountId,
    uploadedAt: now,
    lastModified: now,
    status: 'ACTIVE',
    syncStatus: 'READY',
    source: 'JIRA_MIGRATION',
    jiraAttachmentId: item.jiraAttachmentId,
    projectKey: hierarchy.projectKey,
    issueKey: hierarchy.issueKey,
    epicKey: hierarchy.epicKey,
    storageBucket: (await getStorageProvider({ projectId: run.projectId }) as any).bucketName,
  });
  // Metadata now points at this migration item's persisted attachment, so the
  // diagnostics UI and any retry can correlate the two.
  await migrationRepository.updateMigrationItem(item.id, { status: 'SUCCEEDED', attachmentId });
  return attachmentId;
}

// Deletes the native Jira copy for each already-persisted item, then removes
// any ADF media nodes (description/comment embeds) that referenced the deleted
// copies — otherwise the editor keeps rendering dead "Failed to load" cards
// for files that now live in Project Bucket. A deletion failure here never
// loses data — the Project Bucket copy is durable — it just leaves a duplicate
// lingering in Jira, which we surface as SOURCE_DELETE_FAILED + a SYNC_ERROR
// badge so the user can retry only the deletion.
async function deleteNativeCopiesAndCleanReferences(
  issueId: string,
  targets: { item: StagedItem; attachmentId: string }[]
): Promise<void> {
  // Resolve each attachment's Media Services UUID BEFORE deleting it — the
  // content redirect this relies on stops answering once the attachment is
  // gone. See jiraContentCleanup.ts for the mechanics.
  const mediaIds = (
    await Promise.all(targets.map(({ item }) => resolveMediaId(item.jiraAttachmentId)))
  ).filter((id): id is string => id !== null);

  const anyDeleted = await deleteNativeCopies(targets);

  if (anyDeleted) {
    try {
      await removeMediaReferences(issueId, mediaIds);
    } catch (error) {
      // Cleanup is cosmetic housekeeping; the migration itself already
      // succeeded, so a failure here must never change the run's outcome.
      ((..._args: any[]) => {})(`[ProjectBucket] Post-migration media cleanup failed for issue ${issueId}:`, error);
    }
  }
}

// Returns whether at least one native copy was actually deleted (which is what
// gates the ADF reference cleanup above).
async function deleteNativeCopies(targets: { item: StagedItem; attachmentId: string }[]): Promise<boolean> {
  let anyDeleted = false;
  for (const { item, attachmentId } of targets) {
    try {
      await deleteNativeAttachment(item.jiraAttachmentId);
      anyDeleted = true;
      await migrationRepository.updateMigrationItem(item.id, {
        status: 'SUCCEEDED',
        errorMessage: null,
        completedAt: true,
      });
      await attachmentRepository.updateSyncStatus(attachmentId, 'READY');
    } catch (error) {
      const message = `Migrated successfully, but could not remove the native Jira attachment: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await migrationRepository.updateMigrationItem(item.id, {
        status: 'SOURCE_DELETE_FAILED',
        errorMessage: message,
        completedAt: true,
      });
      await attachmentRepository.updateSyncStatus(attachmentId, 'SYNC_ERROR');
    }
  }
  return anyDeleted;
}

// Computes the run's terminal state from its items after a commit/deletion
// pass. Every item is in Project Bucket at this point; the only question is
// whether any native copy is still lingering.
async function finalizeAfterCommit(run: MigrationRun): Promise<void> {
  const items = await migrationRepository.getStagedMigrationItems(run.id);
  const migrated = items.filter(
    (item) => item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED'
  ).length;
  const anyLingering = items.some((item) => item.status === 'SOURCE_DELETE_FAILED');
  await migrationRepository.setRunFinal(run.id, anyLingering ? 'PARTIAL_FAILURE' : 'COMPLETED', migrated, 0);
}

/**
 * Prepares a terminal run to be retried, dispatching on how it failed:
 *   • FAILED (session aborted at staging)      — reset the failed items to
 *     PENDING so the client re-stages them, then re-open the run. The commit
 *     re-runs from the start once everything is staged again.
 *   • PARTIAL_FAILURE (native deletes failed)  — leave the persisted items
 *     alone and just re-open the run; the commit re-attempts only the
 *     outstanding deletions.
 */
export async function prepareRetry(migrationId: string): Promise<MigrationRun> {
  const run = await migrationRepository.getMigrationRun(migrationId);
  if (!run) throw new Error(`Migration run "${migrationId}" not found`);

  if (run.status === 'FAILED') {
    // Re-stage everything that is not already successfully staged. Besides the
    // FAILED items this also recovers any left UPLOADING/PENDING by a browser
    // that died mid-stage — otherwise those would never be re-attempted and the
    // commit could never see the whole session as staged. SOURCE_MISSING items
    // stay withdrawn: their native source is gone and can never stage again.
    const retryItemIds = run.items
      .filter((item) => item.status !== 'STAGED' && item.status !== 'SOURCE_MISSING')
      .map((item) => item.id);
    await migrationRepository.resetItemsForRetry(migrationId, retryItemIds);
    await migrationRepository.reopenRun(migrationId);
  } else if (run.status === 'PARTIAL_FAILURE') {
    await migrationRepository.reopenRun(migrationId);
  } else {
    return run;
  }

  const refreshed = await migrationRepository.getMigrationRun(migrationId);
  if (!refreshed) throw new Error(`Migration run "${migrationId}" disappeared during retry preparation`);
  return refreshed;
}

export async function listMigrationRunsForIssue(issueId: string): Promise<MigrationRun[]> {
  return migrationRepository.listMigrationRuns(issueId);
}
