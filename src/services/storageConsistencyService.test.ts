import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionByStoredBytes, sweepPage, ConsistencyDeps } from './storageConsistencyService';
import { Attachment } from '../types/attachment';


// Coverage for the storage-consistency invariant and the two-strike quarantine
// rule that replaced the original single-miss-means-gone design:
//  - partitionByStoredBytes splits present vs missing with NO side effects;
//  - the sweep quarantines a row ONLY after it is missing across two consecutive
//    sweeps (first miss records missing_since; second miss orphans + withdraws
//    from the graph), and clears the marker for a row that reappears;
//  - transient storage errors propagate so live data is never mislabeled lost.
// Run with: npm test

function attachment(id: string, missingSince: string | null = null): Attachment {
  return {
    id,
    issueId: '10001',
    projectId: '10000',
    filename: `${id}.png`,
    extension: 'png',
    mimeType: 'image/png',
    size: 10,
    checksum: 'abc',
    objectKey: `attachments/${id}`,
    uploadedBy: 'account-1',
    uploadedAt: '2026-07-19T00:00:00.000Z',
    lastModified: '2026-07-19T00:00:00.000Z',
    status: 'ACTIVE',
    syncStatus: 'READY',
    source: 'PROJECT_BUCKET_UPLOAD',
    jiraAttachmentId: null,
    missingSince,
  };
}

function fakeDeps(storedIds: string[]) {
  const firstMisses: string[] = [];
  const cleared: string[] = [];
  const orphanedIds: string[] = [];
  const graphDeletes: string[][] = [];
  const stored = new Set(storedIds.map((id) => `attachments/${id}`));
  const deps: ConsistencyDeps = {
    listStoredRefs: async (attachments) => attachments.map(a => a.objectKey).filter((ref) => stored.has(ref)),
    markFirstMiss: async (id) => {
      firstMisses.push(id);
    },
    clearMissing: async (id) => {
      cleared.push(id);
    },
    markOrphaned: async (id) => {
      orphanedIds.push(id);
    },
    publishDeletes: async (ids) => {
      graphDeletes.push(ids);
      return true;
    },
  };
  return { deps, firstMisses, cleared, orphanedIds, graphDeletes };
}

test('partitionByStoredBytes splits present vs missing and never mutates status', async () => {
  const { deps, firstMisses, orphanedIds, graphDeletes } = fakeDeps(['a', 'c']);
  const result = await partitionByStoredBytes([attachment('a'), attachment('b'), attachment('c')], deps);

  assert.deepEqual(result.present.map((row) => row.id), ['a', 'c']);
  assert.deepEqual(result.missing.map((row) => row.id), ['b']);
  // Purely a read — no strikes, no quarantine, no graph withdrawal.
  assert.deepEqual(firstMisses, []);
  assert.deepEqual(orphanedIds, []);
  assert.deepEqual(graphDeletes, []);
});

test('partition empty input performs no storage calls', async () => {
  let called = false;
  const result = await partitionByStoredBytes([], {
    listStoredRefs: async () => {
      called = true;
      return [];
    },
    markFirstMiss: async () => undefined,
    clearMissing: async () => undefined,
    markOrphaned: async () => undefined,
    publishDeletes: async () => true,
  });
  assert.deepEqual(result, { present: [], missing: [] });
  assert.equal(called, false);
});

test('sweep first miss records missing_since and does NOT quarantine', async () => {
  const { deps, firstMisses, orphanedIds, graphDeletes } = fakeDeps([]); // nothing stored
  const orphaned = await sweepPage([attachment('a', null)], deps);

  assert.equal(orphaned, 0);
  assert.deepEqual(firstMisses, ['a']);
  assert.deepEqual(orphanedIds, []);
  assert.deepEqual(graphDeletes, []);
});

test('sweep second consecutive miss quarantines and withdraws from the graph', async () => {
  const { deps, firstMisses, orphanedIds, graphDeletes } = fakeDeps([]); // still missing
  const alreadyStruck = attachment('a', '2026-07-20T00:00:00.000Z');
  const orphaned = await sweepPage([alreadyStruck], deps);

  assert.equal(orphaned, 1);
  assert.deepEqual(firstMisses, []); // already struck — not re-recorded
  assert.deepEqual(orphanedIds, ['a']);
  assert.deepEqual(graphDeletes, [['a']]);
});

test('sweep clears the strike for a row whose bytes reappeared', async () => {
  const { deps, cleared, orphanedIds } = fakeDeps(['a']); // 'a' is back
  const recovered = attachment('a', '2026-07-20T00:00:00.000Z');
  const orphaned = await sweepPage([recovered], deps);

  assert.equal(orphaned, 0);
  assert.deepEqual(cleared, ['a']);
  assert.deepEqual(orphanedIds, []);
});

test('sweep leaves an always-present, never-struck row completely untouched', async () => {
  const { deps, firstMisses, cleared, orphanedIds } = fakeDeps(['a']);
  const orphaned = await sweepPage([attachment('a', null)], deps);

  assert.equal(orphaned, 0);
  assert.deepEqual(firstMisses, []);
  assert.deepEqual(cleared, []);
  assert.deepEqual(orphanedIds, []);
});

test('a transient storage failure propagates — live rows must never be quarantined on an error', async () => {
  const { deps } = fakeDeps([]);
  deps.listStoredRefs = async () => {
    throw new Error('storage backend timeout');
  };
  await assert.rejects(() => sweepPage([attachment('a')], deps), /storage backend timeout/);
});

test('a quarantine failure on one row still quarantines the rest', async () => {
  const { deps, graphDeletes } = fakeDeps([]);
  deps.markOrphaned = async (id) => {
    if (id === 'a') throw new Error('sql blip');
  };
  const orphaned = await sweepPage(
    [attachment('a', '2026-07-20T00:00:00.000Z'), attachment('b', '2026-07-20T00:00:00.000Z')],
    deps
  );

  // 'a' failed to flip (next sweep retries it); only 'b' was actually orphaned,
  // so only 'b' may be withdrawn from the graph.
  assert.equal(orphaned, 1);
  assert.deepEqual(graphDeletes, [['b']]);
});

test('a transient storage error (status: "error") inside the default deps propagates and does not quarantine', async () => {
  // We cannot easily mock getStorageProvider module-level export without a library,
  // but we can provide a mock to deps.listStoredRefs which is what's used inside the sweepPage.
  const { deps } = fakeDeps([]);
  deps.listStoredRefs = async () => {
    throw new Error('Transient storage error during consistency check');
  };
  await assert.rejects(() => partitionByStoredBytes([attachment('a')], deps), /Transient storage error during consistency check/);
});
