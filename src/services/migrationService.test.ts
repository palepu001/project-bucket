import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCommit } from './migrationService';
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
