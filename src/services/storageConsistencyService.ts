import { getStorageProvider } from '../storage';
import * as attachmentRepository from '../repositories/attachmentRepository';
import * as graphSyncService from './graphSyncService';
import { Attachment } from '../types/attachment';

// Enforces the invariant that an attachment appears in Project Bucket ONLY
// while its bytes verifiably exist at the storage location. Two responsibilities
// with deliberately different aggressiveness:
//
//   1. The interactive gallery (listAttachments) HIDES rows whose bytes it
//      cannot verify right now, WITHOUT changing their status — a single
//      unverified read must never be destructive. (partitionByStoredBytes.)
//
//   2. The hourly consistency sweep is the ONLY place that quarantines
//      (ACTIVE → ORPHANED), and only after a row is confirmed missing across
//      TWO consecutive sweeps (a first miss just records `missing_since`; a
//      second consecutive miss quarantines and withdraws the metadata from
//      Teamwork Graph). A row that reappears has its `missing_since` cleared.
//      (runStorageSweep.)
//
// This two-strike rule exists because the original single-`undefined`-means-gone
// design let one transient/regressed existence check mass-quarantine an entire
// live library. A file that is genuinely deleted still converges to ORPHANED
// within ~an hour; a blip that heals on the next sweep never touches status.
//
// Note on cause: the loss that motivated this machinery was ultimately the app
// setting a 15-minute object TTL on every upload (see S3StorageProvider
// / the upload resolvers), not platform-side data loss. The invariant is kept as
// genuine defense-in-depth against any location dropping bytes.

// Everything this service touches beyond pure data, injectable so tests can
// exercise the partition/quarantine contract without the Forge runtime.
export interface ConsistencyDeps {
  listStoredRefs(attachments: Attachment[]): Promise<string[]>;
  markFirstMiss(id: string): Promise<void>;
  clearMissing(id: string): Promise<void>;
  markOrphaned(id: string): Promise<void>;
  publishDeletes(attachmentIds: string[]): Promise<boolean>;
}

const defaultDeps: ConsistencyDeps = {
  listStoredRefs: async (attachments) => {
    const grouped = new Map<string, Attachment[]>();
    for (const attachment of attachments) {
      const group = grouped.get(attachment.projectId) || [];
      group.push(attachment);
      grouped.set(attachment.projectId, group);
    }

    const allFoundRefs: string[] = [];
    for (const [projectId, group] of grouped.entries()) {
      const provider = await getStorageProvider({ projectId });
      const refs = group.map((a) => a.objectKey);
      const results = await provider.exists(refs);
      if (results.some((r) => r.status === 'error')) {
        throw new Error(`Transient storage error during consistency check for project ${projectId}`);
      }
      allFoundRefs.push(...results.filter((r) => r.status === 'found').map((r) => r.ref));
    }
    return allFoundRefs;
  },
  markFirstMiss: (id) => attachmentRepository.markFirstMiss(id),
  clearMissing: (id) => attachmentRepository.clearMissing(id),
  markOrphaned: (id) => attachmentRepository.markOrphaned(id),
  publishDeletes: (attachmentIds) => graphSyncService.publishDeletes(attachmentIds),
};

export interface PartitionResult {
  /** Rows whose bytes are verifiably at the storage location — safe to show. */
  present: Attachment[];
  /** Rows whose bytes could not be verified in this pass. */
  missing: Attachment[];
}

// Pure existence partition — NO side effects, never changes any row's status.
// Storage errors propagate to the caller (a transient failure must never be
// treated as data loss — the provider only reports "gone" via an authoritative
// 'missing', and defaultDeps throws if any ref check errored). Used by the
// gallery to hide unverifiable rows and by the sweep to decide what to strike.
export async function partitionByStoredBytes(
  attachments: Attachment[],
  deps: ConsistencyDeps = defaultDeps
): Promise<PartitionResult> {
  if (attachments.length === 0) return { present: [], missing: [] };

  const storedRefs = new Set(await deps.listStoredRefs(attachments));
  const present = attachments.filter((attachment) => storedRefs.has(attachment.objectKey));
  const missing = attachments.filter((attachment) => !storedRefs.has(attachment.objectKey));
  return { present, missing };
}

export interface StorageSweepSummary {
  checked: number;
  orphaned: number;
}

// Site-wide pass over every ACTIVE row, for the hourly scheduled trigger.
// Paginates in batches of 500 by id, processing up to 5000 rows per run
// to stay within Forge invocation time limits. Rows beyond the cap are
// checked in the next hourly run (the keyset cursor guarantees progress).
const SWEEP_PAGE_SIZE = 500;
const SWEEP_MAX_ROWS = 5000;

export async function runStorageSweep(deps: ConsistencyDeps = defaultDeps): Promise<StorageSweepSummary> {
  let totalChecked = 0;
  let totalOrphaned = 0;
  let afterId: string | undefined;

  while (totalChecked < SWEEP_MAX_ROWS) {
    const page = await attachmentRepository.listAllActiveAttachments(SWEEP_PAGE_SIZE, afterId);
    if (page.length === 0) break; // No more rows to process.

    const orphaned = await sweepPage(page, deps);
    totalChecked += page.length;
    totalOrphaned += orphaned;

    // Advance the keyset cursor to the last id in this page.
    afterId = page[page.length - 1].id;

    // If this page was smaller than the requested limit, we've exhausted all rows.
    if (page.length < SWEEP_PAGE_SIZE) break;
  }

  return { checked: totalChecked, orphaned: totalOrphaned };
}

// Applies the two-strike rule to one page and returns how many rows it
// quarantined. Each write is individually best-effort: a row we fail to update
// keeps its current state and the next sweep retries it. Exported for unit
// tests of the strike/quarantine contract.
export async function sweepPage(page: Attachment[], deps: ConsistencyDeps): Promise<number> {
  const { present, missing } = await partitionByStoredBytes(page, deps);

  // A previously-missing row that reappeared: clear its strike so it is never
  // quarantined on the strength of a since-healed blip.
  for (const attachment of present) {
    if (attachment.missingSince) {
      try {
        await deps.clearMissing(attachment.id);
      } catch (error) {
        console.error(`[ProjectBucket] Failed to clear missing marker for ${attachment.id}:`, error);
      }
    }
  }

  const orphaned: Attachment[] = [];
  for (const attachment of missing) {
    try {
      if (!attachment.missingSince) {
        // First strike — record it, do NOT quarantine yet.
        await deps.markFirstMiss(attachment.id);
        console.warn(
          `[ProjectBucket] Attachment ${attachment.id} ("${attachment.filename}", ref ${attachment.objectKey}) ` +
            'missing on this sweep — recorded; will quarantine if still missing next sweep'
        );
      } else {
        // Confirmed missing across two consecutive sweeps — quarantine.
        await deps.markOrphaned(attachment.id);
        orphaned.push(attachment);
        console.warn(
          `[ProjectBucket] Quarantined attachment ${attachment.id} ("${attachment.filename}", ` +
            `ref ${attachment.objectKey}) — bytes confirmed missing across two consecutive sweeps`
        );
      }
    } catch (error) {
      console.error(`[ProjectBucket] Failed to update missing/orphaned state for ${attachment.id}:`, error);
    }
  }

  if (orphaned.length > 0) {
    // Never throws — failed deletes land in the graph outbox for sweep retry.
    await deps.publishDeletes(orphaned.map((attachment) => attachment.id));
  }

  return orphaned.length;
}
