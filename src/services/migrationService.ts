import { randomUUID, createHash, Hash } from 'crypto';
import { Transform, TransformCallback, Readable } from 'stream';
import * as migrationRepository from '../repositories/migrationRepository';
import { StagedMigrationItem as StagedItem } from '../repositories/migrationRepository';
import * as sessionRepository from '../repositories/sessionRepository';
import * as attachmentRepository from '../repositories/attachmentRepository';
import { deleteNativeAttachment, getAttachmentMetadata, downloadNativeAttachmentStream } from './jiraAttachmentSource';
import * as graphSyncService from './graphSyncService';
import { resolveMediaId, removeMediaReferences } from './jiraContentCleanup';
import { getStorageProvider, ChecksumType, ExistenceResult } from '../storage';
import { generateStorageKey, StorageKeyContext } from '../util/storageKey';
import { FileNormalizer } from '../shared/security/normalizer';
import { validateStateless } from '../shared/security/validators/statelessPipeline';
import { getIssueHierarchy } from './jiraIssueHierarchy';
import { AttachmentThumbnailStatus, extensionOf } from '../types/attachment';
import { MigrationItemStatus, MigrationRun } from '../types/migration';
import { verifyIssueAccess } from './jiraIssueAccessService';
import { assertStoredObjectMatchesFilename } from './contentSignatureService';

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
  await verifyIssueAccess(params.issueId);
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
  mimeType?: string;
  checksum: string;
  checksumType: ChecksumType;
  cloudId: string;
}): Promise<{ objectKey: string; uploadUrl: string; method?: string; headers?: Record<string, string> }> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error('Migration run not found');
  await verifyIssueAccess(run.issueId);

  // Same trust boundary the "Add Attachment" path enforces in the uploadObjects
  // resolver. Minting a transfer target IS the moment bytes are allowed to
  // reach the storage location, so it must be gated here and not only in the
  // browser — a client that skips its own checks must still be stopped, and
  // migrated Jira content is the LEAST trusted input the app handles.
  const item = run.items.find((candidate) => candidate.id === params.itemId);
  if (!item) throw new Error(`Migration item "${params.itemId}" not found in run "${params.migrationId}"`);

  const normalizedName = FileNormalizer.normalizeFilename(item.filename);
  const validation = validateStateless({
    filename: normalizedName,
    size: params.length,
    mimeType: params.mimeType ?? 'application/octet-stream',
  });
  if (!validation.passed) {
    await blockItem(params.itemId, item.filename, validation.message ?? 'File type is not allowed.');
    await migrationRepository.touchRunActivity(params.migrationId);
    throw new Error(`"${item.filename}" cannot be migrated — ${validation.message}`);
  }

  await migrationRepository.updateMigrationItem(params.itemId, { status: 'UPLOADING', startedAt: true });
  await migrationRepository.touchRunActivity(params.migrationId);

  // Cached — every item in this run (and its thumbnail upload) asks for the
  // same issue's hierarchy, which cannot change mid-run. See
  // services/jiraIssueHierarchy.ts for why this used to be a per-item Jira
  // round trip.
  const hierarchy = await getIssueHierarchy(run.issueId);
  const storageContext: StorageKeyContext = {
    cloudId: params.cloudId,
    projectKey: hierarchy.projectKey,
    issueKey: hierarchy.issueKey,
    epicKey: hierarchy.epicKey,
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
  thumbnailKey?: string | null;
  thumbnailStatus?: AttachmentThumbnailStatus | null;
}): Promise<{ staged: true }> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error('Migration run not found');
  await verifyIssueAccess(run.issueId);
  const item = run.items.find((candidate) => candidate.id === params.itemId);
  if (!item) throw new Error(`Migration item "${params.itemId}" not found in run "${params.migrationId}"`);

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

  try {
    await assertStoredObjectMatchesFilename(provider, params.objectKey, item.filename);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await blockItem(params.itemId, item.filename, reason);
    await migrationRepository.touchRunActivity(params.migrationId);
    throw error;
  }

  await migrationRepository.updateMigrationItem(params.itemId, {
    status: 'STAGED',
    errorMessage: null,
    objectKey: params.objectKey,
    mimeType: params.mimeType,
    size: params.size,
    checksum: params.checksum,
    thumbnailKey: params.thumbnailKey ?? null,
    thumbnailStatus: params.thumbnailStatus ?? null,
  });
  // Bump the run's heartbeat so the stale-run detector knows a browser is
  // still actively driving this run.
  await migrationRepository.touchRunActivity(params.migrationId);
  return { staged: true };
}

/**
 * Marks one item permanently un-migratable and withdraws it from the session's
 * transaction. Its native Jira copy is left exactly where it is, so "blocked"
 * costs the user nothing beyond the file staying in Jira. Shared by the backend
 * gate in getUploadTarget and the client-reported content check below.
 */
async function blockItem(itemId: string, filename: string, reason: string): Promise<void> {
  await migrationRepository.updateMigrationItem(itemId, {
    status: 'BLOCKED',
    errorMessage:
      `"${filename}" was not moved to Project Bucket — ${reason} ` +
      'It has been left in Jira, and the other files in this session were migrated normally.',
    completedAt: true,
  });
}

/**
 * The client validated the downloaded bytes and rejected them. Only the client
 * can run the magic-number check (it is the only side that holds the bytes), so
 * unlike skipMissingMigrationItem there is nothing to re-verify server-side —
 * and nothing to gain by doing so: the outcome is strictly conservative. A
 * blocked item is withdrawn from the session and its native Jira copy is kept,
 * so a client that lies here only denies itself a migration.
 */
export async function blockMigrationItem(params: {
  migrationId: string;
  itemId: string;
  reason: string;
}): Promise<{ blocked: true }> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error(`Migration run "${params.migrationId}" not found`);
  await verifyIssueAccess(run.issueId);

  const items = await migrationRepository.getStagedMigrationItems(params.migrationId);
  const item = items.find((candidate) => candidate.id === params.itemId);
  if (!item) throw new Error(`Migration item "${params.itemId}" not found`);

  // Terminal-state guard: never rewrite an item that already persisted.
  if (item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED') {
    return { blocked: true };
  }
  await blockItem(params.itemId, item.filename, params.reason);
  await migrationRepository.touchRunActivity(params.migrationId);
  return { blocked: true };
}

/**
 * Records a per-item staging failure, which aborts the whole session at commit.
 *
 * Refuses to overwrite an item that has already reached a terminal state. This
 * matters most for BLOCKED: when the BACKEND gate rejects a file, it also
 * throws, and the client's catch-all reports that throw straight back here — so
 * without this guard the client would immediately downgrade "this file is not
 * allowed, the others migrated fine" into "the session failed", which is
 * exactly the permanently-stuck session BLOCKED exists to prevent.
 */
export async function failMigrationItem(params: {
  migrationId: string;
  itemId: string;
  error: string;
}): Promise<void> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error(`Migration run "${params.migrationId}" not found`);
  await verifyIssueAccess(run.issueId);

  const items = await migrationRepository.getStagedMigrationItems(params.migrationId);
  const item = items.find((candidate) => candidate.id === params.itemId);
  if (
    item &&
    (item.status === 'BLOCKED' ||
      item.status === 'SOURCE_MISSING' ||
      item.status === 'SUCCEEDED' ||
      item.status === 'SOURCE_DELETE_FAILED')
  ) {
    return;
  }

  await migrationRepository.updateMigrationItem(params.itemId, {
    status: 'FAILED',
    errorMessage: params.error,
    completedAt: true,
  });
  await migrationRepository.touchRunActivity(params.migrationId);
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
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error(`Migration run "${params.migrationId}" not found`);
  await verifyIssueAccess(run.issueId);

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
    await migrationRepository.touchRunActivity(params.migrationId);
    return { skipped: false };
  }

  await migrationRepository.updateMigrationItem(params.itemId, {
    status: 'SOURCE_MISSING',
    errorMessage: 'The native Jira attachment no longer exists — it was deleted before it could be linked',
    completedAt: true,
  });
  await migrationRepository.touchRunActivity(params.migrationId);
  return { skipped: true };
}

export type CommitAction = 'nothing-to-do' | 'persist' | 'retry-deletes' | 'abort';

export interface CommitPlan<T extends { status: MigrationItemStatus }> {
  action: CommitAction;
  /** The items still inside the transaction — withdrawn ones removed. */
  present: T[];
  blockedCount: number;
}

/**
 * Identifies items whose Project Bucket copy is not safe enough to justify
 * deleting the native Jira attachment.
 *
 * Pure and exported for the same reason planCommit is: this is a deletion
 * gate. If it says an item is safe when it is not, migration can delete the
 * user's native copy while the Project Bucket copy is missing or corrupt.
 */
export function selectUnsafeNativeDeleteTargets<T extends { objectKey: string | null; size: number | null }>(
  items: T[],
  checks: ExistenceResult[]
): T[] {
  const foundByRef = new Map(
    checks
      .filter((check) => check.status === 'found' && check.summary)
      .map((check) => [check.ref, check.summary!])
  );

  return items.filter((item) => {
    if (!item.objectKey || item.size === null) return true;
    const summary = foundByRef.get(item.objectKey);
    return !summary || summary.size !== item.size;
  });
}

/**
 * Decides what a commit should DO, with no I/O. Pure so the transaction rule —
 * the part where getting it wrong deletes someone's only copy of a file — is
 * directly testable; see migrationService.test.ts.
 *
 * Two statuses are withdrawn from the transaction rather than aborting it:
 *   SOURCE_MISSING — the native source was deleted before staging, so there is
 *     nothing left to migrate and nothing left to protect.
 *   BLOCKED        — the file failed validation and may not go to the storage
 *     location. That verdict is permanent, so aborting would strand the entire
 *     session forever; the native Jira copy is kept instead.
 *
 * Everything else obeys all-or-nothing:
 *   'persist'       — every remaining item is STAGED: persist all metadata,
 *                     then delete all native copies.
 *   'retry-deletes' — every remaining item is already persisted (a retry of a
 *                     PARTIAL_FAILURE run): only re-attempt the deletions.
 *   'abort'         — anything else, including a single item that failed to
 *                     stage: persist nothing, delete nothing, mark FAILED.
 *   'nothing-to-do' — every item was withdrawn. Nothing to migrate, nothing
 *                     lost.
 */
export function planCommit<T extends { status: MigrationItemStatus }>(items: T[]): CommitPlan<T> {
  const isWithdrawn = (status: MigrationItemStatus) =>
    status === 'SOURCE_MISSING' || status === 'BLOCKED';

  const present = items.filter((item) => !isWithdrawn(item.status));
  const blockedCount = items.filter((item) => item.status === 'BLOCKED').length;

  const allStaged = present.length > 0 && present.every((item) => item.status === 'STAGED');
  const allPersisted =
    present.length > 0 &&
    present.every((item) => item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED');

  let action: CommitAction;
  if (items.length > 0 && present.length === 0) action = 'nothing-to-do';
  else if (allStaged) action = 'persist';
  else if (allPersisted) action = 'retry-deletes';
  else action = 'abort';

  return { action, present, blockedCount };
}

/**
 * PHASE 2 — the transaction boundary for the whole upload session. Called once,
 * after the client has attempted to stage every item. See planCommit above for
 * the decision itself; this function only carries it out.
 */
export async function commitMigrationRun(params: {
  migrationId: string;
  actorAccountId: string;
}): Promise<MigrationRun> {
  const run = await migrationRepository.getMigrationRun(params.migrationId);
  if (!run) throw new Error(`Migration run "${params.migrationId}" not found`);
  await verifyIssueAccess(run.issueId);

  // Mutual exclusion, not an optimisation. Two commits racing on the same run
  // each see every item as STAGED, each plan 'persist', and each insert a full
  // set of attachment rows — duplicating every file in the session and double-
  // deleting the native copies. Only the lease holder may proceed.
  const acquired = await migrationRepository.claimCommitLease(params.migrationId, COMMIT_LEASE_MS);
  if (!acquired) {
    // Throw rather than return the run as-is: the run is still RUNNING, and
    // handing a non-terminal run back to the client makes it render a summary
    // flag for an outcome that has not happened yet ("Nothing left to link").
    // An explicit error is both honest and actionable.
    console.warn(
      `[ProjectBucket] commitMigrationRun: run ${params.migrationId} is already being committed elsewhere; refusing to commit twice`
    );
    throw new Error(
      'This migration is already being finished in another tab or by the background sweep. ' +
        'Give it a moment, then reload the issue to see the result.'
    );
  }

  try {
    await commitUnderLease(run, params.actorAccountId);
  } finally {
    // Release even on failure: the user's Retry must work immediately rather
    // than waiting out the lease.
    await migrationRepository.releaseCommitLease(params.migrationId).catch(() => undefined);
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

// The body of the commit, run with the commit lease held. Split out purely so
// the lease acquire/release above reads as one thing.
async function commitUnderLease(run: MigrationRun, actorAccountId: string): Promise<void> {
  const items = await migrationRepository.getStagedMigrationItems(run.id);
  const { action, present, blockedCount } = planCommit(items);

  if (action === 'nothing-to-do') {
    // Every item was withdrawn — sources vanished, files were blocked, or both.
    // Nothing to do and nothing lost: blocked files are still in Jira. The run
    // is complete with zero migrations, and failedCount surfaces the blocks.
    await migrationRepository.setRunFinal(run.id, 'COMPLETED', 0, blockedCount);
  } else if (action === 'persist') {
    await persistAndDeleteSession(run, present, actorAccountId, blockedCount);
  } else if (action === 'retry-deletes') {
    // Retry of a PARTIAL_FAILURE run: metadata already exists, only the native
    // deletions need re-attempting. Re-run deletion for the lingering copies.
    const lingering = items.filter((item) => item.status === 'SOURCE_DELETE_FAILED');
    await deleteNativeCopiesAndCleanReferences(
      run.id,
      run.issueId,
      lingering.map((item) => ({ item, attachmentId: item.attachmentId! }))
    );
    await finalizeAfterCommit(run, blockedCount);
  } else {
    // At least one item failed to stage (or is still pending). Honour the
    // transaction rule: keep every native attachment, persist nothing.
    await migrationRepository.setRunFinal(run.id, 'FAILED', 0, run.requestedCount);
  }
}

// Fresh commit of a fully-staged session: persist every attachment, then
// delete every native copy. If persistence itself fails partway (an unexpected
// DB error), roll back the rows we inserted so the session stays all-or-nothing
// and no native copy is ever deleted.
async function persistAndDeleteSession(
  run: MigrationRun,
  items: StagedItem[],
  actorAccountId: string,
  blockedCount: number
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

  for (const item of items) {
    if (!item.objectKey) continue;
    try {
      await assertStoredObjectMatchesFilename(provider, item.objectKey, item.filename);
    } catch (error) {
      await migrationRepository.setRunFinal(run.id, 'FAILED', 0, run.requestedCount);
      throw error;
    }
  }

  const hierarchy = await getIssueHierarchy(run.issueId);

  const persisted: { item: StagedItem; attachmentId: string }[] = [];
  try {
    for (const item of items) {
      const attachmentId = await persistAttachment(run, item, actorAccountId, hierarchy);
      persisted.push({ item, attachmentId });
      // Heartbeat per item. A large session spends minutes in this loop, and
      // without this the run looks abandoned to the stale-run detector while
      // it is in the middle of the one phase that must never be re-entered.
      await migrationRepository.renewCommitLease(run.id);
    }
    await assertNativeDeleteTargetsAreSafe(run, items);
  } catch (error) {
    for (const { attachmentId } of persisted) {
      await attachmentRepository.deleteAttachmentRow(attachmentId).catch(() => undefined);
    }
    for (const { item } of persisted) {
      await migrationRepository.updateMigrationItem(item.id, {
        status: 'FAILED',
        attachmentId: null,
        errorMessage:
          'Migration aborted before deleting the Jira attachment because the Project Bucket copy could not be re-verified. Retry will re-stage this file.',
        completedAt: true,
      }).catch(() => undefined);
    }
    await migrationRepository.setRunFinal(run.id, 'FAILED', 0, run.requestedCount);
    throw error;
  }

  await deleteNativeCopiesAndCleanReferences(run.id, run.issueId, persisted);
  await finalizeAfterCommit(run, blockedCount);
}

async function assertNativeDeleteTargetsAreSafe(run: MigrationRun, items: StagedItem[]): Promise<void> {
  const objectKeys = items
    .map((item) => item.objectKey)
    .filter((key): key is string => Boolean(key));
  const provider = await getStorageProvider({ projectId: run.projectId });
  const checks = await provider.exists(objectKeys);

  if (checks.some((check) => check.status === 'error')) {
    throw new Error(
      'Native Jira attachments were not deleted because Project Bucket could not re-verify every copied file.'
    );
  }

  const unsafe = selectUnsafeNativeDeleteTargets(items, checks);
  if (unsafe.length > 0) {
    throw new Error(
      `Native Jira attachments were not deleted because ${unsafe.length} Project Bucket ` +
        `cop${unsafe.length === 1 ? 'y is' : 'ies are'} missing or size-mismatched: ` +
        unsafe.map((item) => item.filename).join(', ')
    );
  }
}

async function persistAttachment(run: MigrationRun, item: StagedItem, actorAccountId: string, hierarchy: { projectKey: string, issueKey: string, epicKey: string | null }): Promise<string> {
  if (!item.objectKey || item.size === null) {
    throw new Error(`Item "${item.filename}" is missing staged data and cannot be committed`);
  }
  const attachmentId = randomUUID();
  const now = new Date().toISOString();
  const provider = await getStorageProvider({ projectId: run.projectId });
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
    // The rendition the client generated from the Jira bytes and already
    // uploaded. Recording it is what stops the gallery re-rendering the same
    // image through the backfill path and stops the uploaded object leaking.
    thumbnailKey: item.thumbnailKey,
    thumbnailStatus: item.thumbnailStatus,
    projectKey: hierarchy.projectKey,
    issueKey: hierarchy.issueKey,
    epicKey: hierarchy.epicKey,
    storageBucket: provider.containerName,
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
  migrationId: string,
  issueId: string,
  targets: { item: StagedItem; attachmentId: string }[]
): Promise<void> {
  // Resolve each attachment's Media Services UUID BEFORE deleting it — the
  // content redirect this relies on stops answering once the attachment is
  // gone. See jiraContentCleanup.ts for the mechanics.
  const mediaIds = (
    await Promise.all(targets.map(({ item }) => resolveMediaId(item.jiraAttachmentId)))
  ).filter((id): id is string => id !== null);
  await migrationRepository.renewCommitLease(migrationId);

  const anyDeleted = await deleteNativeCopies(migrationId, targets);

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
async function deleteNativeCopies(
  migrationId: string,
  targets: { item: StagedItem; attachmentId: string }[]
): Promise<boolean> {
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
    // Heartbeat per deletion, for the same reason as the persist loop above:
    // one Jira REST round trip per file adds up on a large session.
    await migrationRepository.renewCommitLease(migrationId);
  }
  return anyDeleted;
}

// Computes the run's terminal state from its items after a commit/deletion
// pass. Every item is in Project Bucket at this point; the only question is
// whether any native copy is still lingering.
async function finalizeAfterCommit(run: MigrationRun, blockedCount = 0): Promise<void> {
  const items = await migrationRepository.getStagedMigrationItems(run.id);
  const migrated = items.filter(
    (item) => item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED'
  ).length;
  const anyLingering = items.some((item) => item.status === 'SOURCE_DELETE_FAILED');
  // Blocked files count as "not migrated" so the run's own numbers admit that
  // something stayed in Jira, but they do NOT make the run retryable: the
  // migratable half really did finish, and re-running would reach the same
  // verdict on the same bytes.
  await migrationRepository.setRunFinal(
    run.id,
    anyLingering ? 'PARTIAL_FAILURE' : 'COMPLETED',
    migrated,
    blockedCount
  );
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
  await verifyIssueAccess(run.issueId);

  if (run.status === 'FAILED') {
    // Re-stage everything that is not already successfully staged. Besides the
    // FAILED items this also recovers any left UPLOADING/PENDING by a browser
    // that died mid-stage — otherwise those would never be re-attempted and the
    // commit could never see the whole session as staged. SOURCE_MISSING and
    // BLOCKED items stay withdrawn: the first has no source left to stage, and
    // the second would fail the identical checks on the identical bytes.
    const retryItemIds = run.items
      .filter(
        (item) =>
          item.status !== 'STAGED' && item.status !== 'SOURCE_MISSING' && item.status !== 'BLOCKED'
      )
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

// Stale-run detection threshold: a RUNNING run with no heartbeat for this long
// is presumed abandoned by whoever was driving it.
//
// Sized against the slowest legitimate gap between two heartbeats, which is the
// stretch inside stageOne between getUploadTarget (writes UPLOADING) and
// stageMigrationItem (writes STAGED): a full download from Jira, a SHA-256 over
// the whole blob, thumbnail rendering, and the PUT to storage — for a file up
// to MAX_FILE_SIZE_BYTES (256 MB), with UPLOAD_CONCURRENCY=3 of them competing
// for the same connection. Two minutes is comfortably inside that window on an
// ordinary link, which would make a perfectly healthy run look abandoned and
// let the very tab running it hijack itself. Ten minutes is past the point
// where the browser would have given up anyway.
//
// The cost of erring long is only that an abandoned run waits longer before a
// returning user resumes it — and the hourly sweep (sweepAbandonedRuns) is the
// backstop for the case where nobody ever returns.
const STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000;

// How long a commit lease is honoured before another commit may steal it. The
// commit renews it per item, so this only ever elapses if the container running
// the commit actually died.
const COMMIT_LEASE_MS = 5 * 60 * 1000;

/**
 * Atomically claims a RUNNING migration on this issue that has been idle longer
 * than STALE_RUN_THRESHOLD_MS, resets the items that were in flight when its
 * browser died back to PENDING, and returns the refreshed run so the calling
 * browser can resume the pipeline.
 *
 * Returns null when there is nothing to recover — no RUNNING run exists, the
 * existing one is still being actively driven, a commit is in flight against
 * it, or another poller won the claim. The caller must not show recovery UI in
 * any of those cases.
 */
export async function recoverStaleRun(issueId: string): Promise<MigrationRun | null> {
  await verifyIssueAccess(issueId);
  // Claiming is a compare-and-swap that also bumps the heartbeat, so no other
  // tab (or the sweep) can pick up the same run while this browser resumes it.
  const staleRun = await migrationRepository.claimStaleRunningRun(issueId, STALE_RUN_THRESHOLD_MS);
  if (!staleRun) return null;

  console.log(
    `[ProjectBucket] recoverStaleRun: claimed stale run ${staleRun.id} for issue ${issueId} ` +
      `with ${staleRun.items.length} item(s)`
  );

  // Reset the items that were in-flight when the browser died back to PENDING
  // so the resuming browser re-stages them — see selectResumableItems.
  const stuckItemIds = selectResumableItems(staleRun.items).map((item) => item.id);

  if (stuckItemIds.length > 0) {
    await migrationRepository.resetItemsForRetry(staleRun.id, stuckItemIds);
    await migrationRepository.touchRunActivity(staleRun.id);
  }

  const refreshed = await migrationRepository.getMigrationRun(staleRun.id);
  if (!refreshed) throw new Error(`Stale run ${staleRun.id} disappeared during recovery`);

  console.log(
    `[ProjectBucket] recoverStaleRun: recovered run ${refreshed.id}, ` +
      `${stuckItemIds.length} item(s) reset to PENDING`
  );
  return refreshed;
}

// ---------------------------------------------------------------------------
// Abandoned-run sweep — the server-side backstop.
//
// recoverStaleRun above only fires while somebody is looking at the issue: the
// watcher is a jira:issueViewBackgroundScript, so it dies with the issue view.
// A user who clicks "Link All" and then navigates to a DIFFERENT issue leaves a
// run that nothing in the browser will ever come back to. Without this sweep
// that run stays RUNNING forever: the native Jira copies are never deleted, and
// the staged objects sit in the bucket unreferenced.
//
// So this runs hourly and converges those runs without any user present.
// ---------------------------------------------------------------------------

// Much longer than STALE_RUN_THRESHOLD_MS so the browser-side path always gets
// first refusal: a user who returns to the issue resumes their own run with the
// familiar "Resuming…" flag, and only runs nobody came back to reach the sweep.
const ABANDONED_RUN_THRESHOLD_MS = 30 * 60 * 1000;

// Bounded so one sweep can never run long enough to be killed partway. Anything
// left over is picked up by the next hourly invocation.
const ABANDONED_RUN_SWEEP_LIMIT = 25;

export interface AbandonedRunSweepSummary {
  examined: number;
  committed: number;
  aborted: number;
  objectsReclaimed: number;
  needsAttention: number;
}

export type AbandonedRunAction = 'finish' | 'abort-and-reclaim' | 'needs-review';

/**
 * Decides what the sweep should DO with an abandoned run, with no I/O. Pure for
 * the same reason planCommit is: 'abort-and-reclaim' DELETES OBJECTS, so a
 * wrong answer here destroys files that a live attachment row still points at.
 * See migrationService.test.ts.
 *
 *   'finish'            — the remaining work is all backend work (every item is
 *                         staged, already persisted, or withdrawn), so the
 *                         sweep can commit the session with no browser present.
 *   'abort-and-reclaim' — at least one item never got staged and only a browser
 *                         can move those bytes, AND nothing was ever persisted.
 *                         Nothing has been deleted from Jira, so the run can be
 *                         failed and its staged objects reclaimed safely.
 *   'needs-review'      — the run died PARTWAY THROUGH the irreversible half:
 *                         some items are already persisted as real attachments
 *                         while others never staged. Their object keys are
 *                         referenced by attachment rows, so reclaiming would
 *                         delete live files. Never guess here.
 */
export function planAbandonedRun<T extends { status: MigrationItemStatus }>(
  items: T[]
): AbandonedRunAction {
  const { action } = planCommit(items);
  if (action !== 'abort') return 'finish';

  const anyPersisted = items.some(
    (item) => item.status === 'SUCCEEDED' || item.status === 'SOURCE_DELETE_FAILED'
  );
  return anyPersisted ? 'needs-review' : 'abort-and-reclaim';
}

/**
 * The items a recovered run must re-stage: those that were in flight when the
 * browser died. Pure so the boundary is testable.
 *
 * FAILED is included deliberately — a run that never reached a terminal state
 * has failures belonging to the interrupted attempt, which deserve one more
 * try. Items whose work is durably recorded (STAGED, SUCCEEDED,
 * SOURCE_DELETE_FAILED) and items permanently withdrawn (BLOCKED,
 * SOURCE_MISSING) are left exactly as they are.
 */
export function selectResumableItems<T extends { status: MigrationItemStatus }>(items: T[]): T[] {
  return items.filter(
    (item) => item.status === 'PENDING' || item.status === 'UPLOADING' || item.status === 'FAILED'
  );
}

export async function sweepAbandonedRuns(): Promise<AbandonedRunSweepSummary> {
  const runs = await migrationRepository.listStaleRunningRuns(
    ABANDONED_RUN_THRESHOLD_MS,
    ABANDONED_RUN_SWEEP_LIMIT
  );
  const summary: AbandonedRunSweepSummary = {
    examined: runs.length,
    committed: 0,
    aborted: 0,
    objectsReclaimed: 0,
    needsAttention: 0,
  };

  for (const run of runs) {
    // Take the same lease a browser commit would, so the sweep can never run
    // concurrently with a client that woke up at the same moment.
    const acquired = await migrationRepository.claimCommitLease(run.id, COMMIT_LEASE_MS);
    if (!acquired) continue;

    try {
      const items = await migrationRepository.getStagedMigrationItems(run.id);

      if (planAbandonedRun(items) === 'finish') {
        // Every remaining item is staged (or already persisted, or withdrawn),
        // and all of that is pure backend work — no browser needed. Finish the
        // session on the abandoning user's behalf, attributed to whoever
        // triggered it.
        console.log(`[ProjectBucket] sweepAbandonedRuns: completing abandoned run ${run.id}`);
        await commitUnderLease(run, run.triggeredBy);
        summary.committed += 1;
      } else {
        await abortAbandonedRun(run, items, summary);
      }
    } catch (error) {
      console.error(`[ProjectBucket] sweepAbandonedRuns: run ${run.id} failed to converge:`, error);
    } finally {
      await migrationRepository.releaseCommitLease(run.id).catch(() => undefined);
    }
  }

  return summary;
}

/**
 * Handles an abandoned run that CANNOT be finished server-side, because at
 * least one item never got staged and only a browser can move those bytes.
 *
 * Honours the transaction rule exactly as a failed commit does: nothing is
 * persisted and no native Jira copy is touched, so the user still has every
 * original attachment. Everything not permanently withdrawn is reset to PENDING
 * and its staged object deleted, which both reclaims the leaked bytes and
 * leaves the run cleanly retryable from the start.
 *
 * Records what it did into `summary`.
 */
async function abortAbandonedRun(
  run: MigrationRun,
  items: StagedItem[],
  summary: AbandonedRunSweepSummary
): Promise<void> {
  // Guard against the one case where deleting staged objects would be
  // destructive: a run that died PARTWAY THROUGH the irreversible half, leaving
  // some items already persisted as real attachments. Their object keys are now
  // referenced by attachment rows, so reclaiming them would delete live files.
  // This needs a human, not a cron job — leave it exactly as-is and say so.
  if (planAbandonedRun(items) === 'needs-review') {
    summary.needsAttention += 1;
    console.warn(
      `[ProjectBucket] sweepAbandonedRuns: run ${run.id} on issue ${run.issueId} is half-committed ` +
        `(${items.filter((i) => i.status === 'SUCCEEDED' || i.status === 'SOURCE_DELETE_FAILED').length} ` +
        `item(s) already persisted, ${items.filter((i) => i.status === 'STAGED').length} still staged). ` +
        'Leaving it untouched — reclaiming its objects could delete live attachments. Needs manual review.'
    );
    return;
  }

  // Nothing was ever persisted, so every staged object belongs solely to this
  // aborted attempt and is safe to reclaim.
  let reclaimed = 0;
  const stagedKeys = items
    .filter((item) => item.status === 'STAGED')
    .map((item) => item.objectKey)
    .filter((key): key is string => Boolean(key));

  if (stagedKeys.length > 0) {
    try {
      const provider = await getStorageProvider({ projectId: run.projectId });
      for (const key of stagedKeys) {
        await provider.delete(key);
        reclaimed += 1;
      }
    } catch (error) {
      // A leaked object costs storage, never correctness. Never let it stop the
      // run from reaching a terminal state.
      console.error(`[ProjectBucket] sweepAbandonedRuns: could not reclaim staged objects for ${run.id}:`, error);
    }
  }

  // Reset everything that is not permanently withdrawn, so a retry re-stages
  // from scratch rather than trusting the objects just deleted.
  const retryableItemIds = items
    .filter((item) => item.status !== 'SOURCE_MISSING' && item.status !== 'BLOCKED')
    .map((item) => item.id);
  await migrationRepository.resetItemsForRetry(run.id, retryableItemIds);

  // Same terminal shape a failed commit produces, so Retry behaves identically.
  await migrationRepository.setRunFinal(run.id, 'FAILED', 0, run.requestedCount);

  summary.aborted += 1;
  summary.objectsReclaimed += reclaimed;
  console.log(
    `[ProjectBucket] sweepAbandonedRuns: aborted run ${run.id} — nothing migrated, ` +
      `every native Jira attachment left in place, ${reclaimed} staged object(s) reclaimed`
  );
}

export async function listMigrationRunsForIssue(issueId: string): Promise<MigrationRun[]> {
  return migrationRepository.listMigrationRuns(issueId);
}

export class HashingStream extends Transform {
  private hash: Hash;
  private bytesWritten: number = 0;

  constructor() {
    super();
    this.hash = createHash('sha256');
  }

  _transform(chunk: any, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesWritten += chunk.length;
    this.hash.update(chunk);
    this.push(chunk);
    callback();
  }

  getHashBase64(): string {
    return this.hash.digest('base64');
  }

  getBytesWritten(): number {
    return this.bytesWritten;
  }
}

export function getReadableStream(readable: any): Readable {
  if (readable instanceof Readable) {
    return readable;
  }
  if (readable && typeof readable.getReader === 'function') {
    const reader = readable.getReader();
    return new Readable({
      async read() {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.push(null);
          } else {
            this.push(Buffer.from(value));
          }
        } catch (err: any) {
          this.destroy(err);
        }
      }
    });
  }
  return Readable.from(readable);
}

// ---------------------------------------------------------------------------
// Called from the migrateSessionOnBackend RESOLVER — runs under the standard
// 25-second Forge function limit, so it only creates the DB run and queues an
// async event. The actual byte-streaming happens in executeMigrationRun below,
// which is called by the 900-second async worker (onMigrateSessionEvent).
// ---------------------------------------------------------------------------
export async function migrateSessionOnBackend(params: {
  sessionId: string;
  issueId: string;
  projectId: string;
  actorAccountId: string;
  cloudId: string;
  items: { jiraAttachmentId: string; filename: string }[];
}): Promise<{ runId: string; status: 'RUNNING' }> {
  const { sessionId, issueId, projectId, actorAccountId, cloudId, items } = params;

  const session = await sessionRepository.getSessionById(sessionId);
  if (!session) throw new Error(`Attachment session "${sessionId}" not found`);

  await sessionRepository.markSessionNotified(sessionId);

  // Create the DB run synchronously — this is fast (a few SQL inserts) and
  // must happen here so the browser's poll loop has a runId to track.
  const run = await beginMigration({
    issueId,
    projectId,
    sessionId,
    triggeredBy: actorAccountId,
    items,
  });

  // Push the heavy streaming work onto the async queue. The worker (see
  // src/index.ts onMigrateSessionEvent) has up to 900 seconds to complete it.
  // We import Queue lazily to avoid requiring @forge/events in test contexts
  // that do not have the Forge runtime environment available.
  const { Queue } = await import('@forge/events');
  // QueueParams uses 'key' (the queue name declared in manifest.yml).
  // push() takes a PushEvent<T> which wraps the payload in a 'body' property;
  // the async consumer receives event.body with these fields.
  const migrationQueue = new Queue({ key: 'migrate-session-queue' });
  await migrationQueue.push({ body: { migrationId: run.id, cloudId } });

  console.log(`[ProjectBucket] migrateSessionOnBackend: queued async job for run ${run.id} (${items.length} item(s))`);

  // Return the runId immediately. The browser watcher polls getMigrationRunStatus
  // until the async worker marks the run COMPLETED, FAILED, or PARTIAL_FAILURE.
  return { runId: run.id, status: 'RUNNING' };
}

// ---------------------------------------------------------------------------
// Called from the ASYNC WORKER (onMigrateSessionEvent in src/index.ts).
// Runs under a 900-second Forge function timeout so even large files (250 MB+)
// can be fully downloaded from Jira and uploaded to S3 without timing out.
// ---------------------------------------------------------------------------
export async function executeMigrationRun(migrationId: string, cloudId: string): Promise<void> {
  const run = await migrationRepository.getMigrationRun(migrationId);
  if (!run) throw new Error(`Migration run "${migrationId}" not found`);

  // Guard: if the run is already in a terminal state (e.g. committed by the
  // consistency sweep or a concurrent call) there is nothing to do.
  if (run.status !== 'RUNNING') {
    console.log(`[ProjectBucket] executeMigrationRun: run ${migrationId} is already ${run.status}, skipping`);
    return;
  }

  // Who triggered this migration? Needed for commitUnderLease → attachmentRepository.
  // It is stored as triggered_by on the run row.
  const actorAccountId = (run as any).triggeredBy ?? 'system';

  const runItems = await migrationRepository.getStagedMigrationItems(migrationId);

  // Stream each PENDING/UPLOADING item: download from Jira, pipe through the
  // hashing transform, and PUT into the S3-compatible object store. Items run
  // sequentially to avoid overwhelming the Jira download endpoint or Forge's
  // egress concurrency limits. The 900-second timeout makes this safe for any
  // realistic file count and size.
  for (const item of runItems) {
    if (item.status !== 'PENDING' && item.status !== 'UPLOADING') {
      continue;
    }

    try {
      await migrationRepository.updateMigrationItem(item.id, {
        status: 'UPLOADING',
        startedAt: true,
      });

      const meta = await getAttachmentMetadata(item.jiraAttachmentId);
      if (!meta) {
        throw new Error('Attachment is missing in Jira');
      }

      console.log(`[ProjectBucket] executeMigrationRun: streaming "${item.filename}" (${meta.size} bytes)`);

      const downloadStream = await downloadNativeAttachmentStream(item.jiraAttachmentId);
      const hasher = new HashingStream();
      const piped = getReadableStream(downloadStream).pipe(hasher);

      const hierarchy = await getIssueHierarchy(run.issueId);
      const storageContext: StorageKeyContext = {
        cloudId,
        projectKey: hierarchy.projectKey,
        issueKey: hierarchy.issueKey,
        epicKey: hierarchy.epicKey,
      };
      const objectKey = generateStorageKey(storageContext);

      const provider = await getStorageProvider({ projectId: run.projectId });
      await provider.uploadStream(objectKey, piped, meta.size, meta.mimeType, '');

      const finalChecksum = hasher.getHashBase64();
      const bytesWritten = hasher.getBytesWritten();
      if (bytesWritten !== meta.size) {
        throw new Error(`Size mismatch: expected ${meta.size} bytes, got ${bytesWritten}`);
      }

      await stageMigrationItem({
        migrationId,
        itemId: item.id,
        objectKey,
        mimeType: meta.mimeType,
        size: bytesWritten,
        checksum: finalChecksum,
      });

      console.log(`[ProjectBucket] executeMigrationRun: staged "${item.filename}" successfully`);
    } catch (error: any) {
      console.error(`[ProjectBucket] executeMigrationRun: item "${item.filename}" failed:`, error);
      const isMissing =
        error.message?.includes('missing in Jira') ||
        error.message?.includes('404') ||
        error.status === 404;

      if (isMissing) {
        await migrationRepository.updateMigrationItem(item.id, {
          status: 'SOURCE_MISSING',
          errorMessage: 'Attachment no longer exists in Jira',
          completedAt: true,
        });
      } else {
        await failMigrationItem({
          migrationId,
          itemId: item.id,
          error: error.message || String(error),
        });
      }
    }
  }

  // All items processed in this worker execution — commit or finalize the run.
  // Acquire the commit lease (releasing any temporary recovery lease if needed)
  // so the run transitions to COMPLETED or FAILED and never gets stuck in RUNNING.
  let acquiredLease = await migrationRepository.claimCommitLease(migrationId, COMMIT_LEASE_MS);
  if (!acquiredLease) {
    await migrationRepository.releaseCommitLease(migrationId).catch(() => undefined);
    acquiredLease = await migrationRepository.claimCommitLease(migrationId, COMMIT_LEASE_MS);
  }

  if (acquiredLease) {
    try {
      await commitUnderLease(run, actorAccountId);
    } finally {
      await migrationRepository.releaseCommitLease(migrationId).catch(() => undefined);
    }
  }

  const finalRun = await migrationRepository.getMigrationRun(migrationId);
  console.log(
    `[ProjectBucket] executeMigrationRun: run ${migrationId} finished with status=${finalRun?.status ?? 'unknown'}`
  );
}


export async function forceRecoverSessionMigration(sessionId: string): Promise<MigrationRun | null> {
  const run = await migrationRepository.getActiveRunForSession(sessionId);
  if (!run) return null;
  await verifyIssueAccess(run.issueId);

  const stuckItemIds = selectResumableItems(run.items).map((item) => item.id);
  if (stuckItemIds.length > 0) {
    await migrationRepository.resetItemsForRetry(run.id, stuckItemIds);
    await migrationRepository.touchRunActivity(run.id);
  }
  return migrationRepository.getMigrationRun(run.id);
}

