import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAbandonedRun, planCommit, selectResumableItems } from './migrationService';
import { MigrationItemStatus } from '../types/migration';

// Coverage for the migration transaction rule. This is the decision that says
// whether native Jira copies get deleted, so getting it wrong is how a user
// loses the only copy of a file. The rules under test:
//
//   • all-or-nothing — ONE item that failed to stage aborts the whole session
//     and nothing is deleted from Jira;
//   • SOURCE_MISSING and BLOCKED are WITHDRAWN, not failures — they must not
//     abort a session, because both are permanent and would otherwise strand
//     every sibling file in Jira forever;
//   • a session of nothing but withdrawn items is a no-op, not a failure.
//
// Run with: npm test

const items = (...statuses: MigrationItemStatus[]) => statuses.map((status, i) => ({ status, id: `i${i}` }));

test('every item staged → persist the session', () => {
  const plan = planCommit(items('STAGED', 'STAGED'));
  assert.equal(plan.action, 'persist');
  assert.equal(plan.present.length, 2);
  assert.equal(plan.blockedCount, 0);
});

test('ONE item that failed to stage aborts the whole session', () => {
  // The critical invariant: no native Jira copy may be deleted when any sibling
  // failed, so this must be 'abort' and never 'persist'.
  const plan = planCommit(items('STAGED', 'STAGED', 'FAILED'));
  assert.equal(plan.action, 'abort');
});

test('an item still mid-flight aborts rather than committing a partial session', () => {
  assert.equal(planCommit(items('STAGED', 'UPLOADING')).action, 'abort');
  assert.equal(planCommit(items('STAGED', 'PENDING')).action, 'abort');
});

test('a blocked item is withdrawn — its siblings still migrate', () => {
  const plan = planCommit(items('STAGED', 'BLOCKED', 'STAGED'));
  assert.equal(plan.action, 'persist', 'a blocked file must not abort the session');
  assert.equal(plan.present.length, 2, 'the blocked item must be outside the transaction');
  assert.equal(plan.blockedCount, 1);
});

test('a missing source is withdrawn — its siblings still migrate', () => {
  const plan = planCommit(items('STAGED', 'SOURCE_MISSING'));
  assert.equal(plan.action, 'persist');
  assert.equal(plan.present.length, 1);
  assert.equal(plan.blockedCount, 0);
});

test('withdrawing does not rescue a session that has a real failure', () => {
  // BLOCKED is withdrawn, but FAILED still aborts — being lenient about one
  // must not make us lenient about the other.
  assert.equal(planCommit(items('BLOCKED', 'FAILED', 'STAGED')).action, 'abort');
});

test('a session of only withdrawn items is a no-op, not a failure', () => {
  const plan = planCommit(items('BLOCKED', 'SOURCE_MISSING'));
  assert.equal(plan.action, 'nothing-to-do');
  assert.equal(plan.present.length, 0);
  assert.equal(plan.blockedCount, 1);
});

test('a session of only blocked items reports every block', () => {
  const plan = planCommit(items('BLOCKED', 'BLOCKED', 'BLOCKED'));
  assert.equal(plan.action, 'nothing-to-do');
  assert.equal(plan.blockedCount, 3);
});

test('an already-persisted run only re-attempts its native deletions', () => {
  const plan = planCommit(items('SUCCEEDED', 'SOURCE_DELETE_FAILED'));
  assert.equal(plan.action, 'retry-deletes');
});

test('a persisted run with blocked siblings still only retries deletions', () => {
  const plan = planCommit(items('SUCCEEDED', 'SOURCE_DELETE_FAILED', 'BLOCKED'));
  assert.equal(plan.action, 'retry-deletes');
  assert.equal(plan.blockedCount, 1);
});

test('a half-persisted, half-staged run aborts rather than guessing', () => {
  assert.equal(planCommit(items('SUCCEEDED', 'STAGED')).action, 'abort');
});

test('an empty run aborts rather than reporting a successful no-op', () => {
  // Distinct from "everything was withdrawn": an empty item list means the run
  // is malformed, and must not read as a completed migration.
  assert.equal(planCommit([]).action, 'abort');
});

// ---------------------------------------------------------------------------
// Abandoned-run recovery. The whole migration pipeline is driven from the issue
// view, so a run whose browser went away has to be converged by someone else —
// either a returning tab or the hourly sweep. Two decisions carry real risk:
//
//   • planAbandonedRun, because 'abort-and-reclaim' DELETES OBJECTS. Answering
//     it wrong for a run that already persisted attachments deletes the bytes a
//     live attachment row points at — the same class of loss planCommit exists
//     to prevent, reached from the other direction.
//   • selectResumableItems, because resetting an item wipes its staged state.
//     Resetting one that is already durably recorded re-uploads it; resetting a
//     withdrawn one re-attempts work that is permanently settled.
// ---------------------------------------------------------------------------

test('an abandoned run that is fully staged is finished, not aborted', () => {
  // Nothing here needs a browser — the sweep can commit it outright, which is
  // the whole point of the backstop.
  assert.equal(planAbandonedRun(items('STAGED', 'STAGED')), 'finish');
});

test('an abandoned run mid-upload is aborted and its objects reclaimed', () => {
  // Only a browser can stage the PENDING item, and nothing was ever persisted,
  // so failing the run leaves every native Jira copy in place and the staged
  // bytes are safe to reclaim.
  assert.equal(planAbandonedRun(items('STAGED', 'PENDING')), 'abort-and-reclaim');
  assert.equal(planAbandonedRun(items('UPLOADING', 'FAILED')), 'abort-and-reclaim');
});

test('an abandoned run that already persisted anything is never reclaimed', () => {
  // THE dangerous case: these object keys are referenced by real attachment
  // rows, so reclaiming them would delete live files. Must escalate, not guess.
  assert.equal(planAbandonedRun(items('SUCCEEDED', 'PENDING')), 'needs-review');
  assert.equal(planAbandonedRun(items('SOURCE_DELETE_FAILED', 'FAILED')), 'needs-review');
  assert.equal(planAbandonedRun(items('SUCCEEDED', 'STAGED', 'UPLOADING')), 'needs-review');
});

test('an abandoned run awaiting only native deletions is finished', () => {
  assert.equal(planAbandonedRun(items('SUCCEEDED', 'SOURCE_DELETE_FAILED')), 'finish');
});

test('an abandoned run of only withdrawn items is finished, not aborted', () => {
  assert.equal(planAbandonedRun(items('BLOCKED', 'SOURCE_MISSING')), 'finish');
});

test('resuming re-stages only the items that were in flight', () => {
  const resumable = selectResumableItems(items('PENDING', 'UPLOADING', 'FAILED'));
  assert.equal(resumable.length, 3, 'every in-flight status must be re-staged');
});

test('resuming never touches durably recorded or withdrawn items', () => {
  // STAGED bytes are verified in storage and SUCCEEDED ones are already
  // persisted, so resetting either would redo work that is already banked.
  // BLOCKED and SOURCE_MISSING are permanent verdicts.
  const untouched = items('STAGED', 'SUCCEEDED', 'SOURCE_DELETE_FAILED', 'BLOCKED', 'SOURCE_MISSING');
  assert.deepEqual(selectResumableItems(untouched), []);
});

test('a recovered run whose commit was interrupted has nothing to re-stage', () => {
  // All-STAGED means the upload phase finished and only the commit was lost.
  // Resuming must go straight to commit rather than re-uploading anything.
  assert.deepEqual(selectResumableItems(items('STAGED', 'STAGED')), []);
  assert.equal(planAbandonedRun(items('STAGED', 'STAGED')), 'finish');
});
