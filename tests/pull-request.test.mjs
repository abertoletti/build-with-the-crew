import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { managePull } from '../plugins/metodo/scripts/pull-request.mjs';
import { ClaudeAuthError } from '../plugins/metodo/scripts/claude-auth.mjs';

test('an authenticated retry on the same commit can use the full review budget', t => {
  const { run, state } = fixture(t);
  state.policy.maxReviewRounds = 1;
  assert.throws(() => run('review', undefined, { review() { throw new ClaudeAuthError(); } }), ClaudeAuthError);
  assert.equal(run('review-status').state, 'awaiting-auth');
  assert.equal(run('review-status').round, 0);
  assert.throws(() => run('verify'), /approved/);
  assert.equal(run('review').verdict, 'approved');
  assert.equal(run('review-status').round, 1);
});

const oid = n => n.toString(16).padStart(40, '0');
const repository = 'example/app';
const pull = 'repos/example/app/pulls/9';
const skills = ['code-review-excellence'];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'metodo-pr-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const brief = join(dir, 'brief.txt');
  writeFileSync(brief, 'Skip duplicate notifications.');
  const state = {
    pr: { state: 'open', draft: false, merged: false, base: { ref: 'main', sha: oid(1), repo: { full_name: repository } }, head: { sha: oid(2) } },
    policy: {
      repository, baseBranch: 'main', integration: 'merge', maxReviewRounds: 3,
      roles: { review: { model: 'opus', skills } },
      requiredChecks: [{ type: 'status', name: 'unit' }, { type: 'check', name: 'build', appId: 7 }],
    },
    statuses: [{ context: 'UNIT', state: 'success' }, { context: 'unit', state: 'failure' }],
    runs: [], verdict: 'approved', reviews: [], writes: [], reads: [],
  };
  const green = () => { state.runs = [{ name: 'build', head_sha: state.pr.head.sha, app: { id: 7 }, status: 'completed', conclusion: 'success' }]; };
  green();
  function request(path, ...args) {
    state.reads.push(path);
    if (path === pull) return structuredClone(state.pr);
    if (path === pull + '/merge') {
      state.writes.push(args);
      state.beforePut?.();
      assert.deepEqual(args.slice(0, 3), ['--method', 'PUT', '-f']);
      if (args[3] !== 'sha=' + state.pr.head.sha) throw new Error('409 head changed on server');
      state.pr.merged = true;
      state.pr.state = 'closed';
      state.pr.merge_commit_sha = oid(20);
      state.afterPut?.();
      return { merged: true, sha: state.pr.merge_commit_sha };
    }
    const commits = 'repos/example/app/commits/' + state.pr.head.sha;
    assert.deepEqual(args, ['--paginate', '--slurp']);
    if (path === commits + '/statuses?per_page=100') return [[], state.statuses];
    if (path === commits + '/check-runs?filter=latest&per_page=100') {
      const runs = structuredClone(state.runs);
      state.afterChecks?.();
      return [{ check_runs: [] }, { check_runs: runs }];
    }
    throw Error('Unexpected fixture endpoint ' + path);
  }
  function review(input) {
    state.reviews.push(input);
    return {
      role: 'review', verdict: state.verdict, baseSha: input.baseSha, headSha: input.headSha,
      requestedModel: input.model, model: 'claude-opus-fixture', sessionId: 'fixture-session',
      agentToolUseId: 'fixture-dispatch', diffSha256: 'a'.repeat(64), skills: input.skills,
      ...state.receiptOverrides,
    };
  }
  const run = (verb, arg = brief, overrides = {}) => managePull(verb, repository, '9', arg, {
    cwd: dir, request, review, configAt: (_cwd, rev) => {
      assert.equal(rev, state.pr.base.sha);
      return state.policy;
    }, commonDir: () => dir, ...overrides,
  });
  return { state, run, green, brief };
}

test('rejection, deduplication, corrected HEAD, second independent review, fresh checks and conditional merge', t => {
  const { state, run, green } = fixture(t);
  state.verdict = 'changes_requested';
  assert.equal(run('review').verdict, 'changes_requested');
  assert.throws(() => run('merge'), /review|changes/i);
  assert.equal(run('review').verdict, 'changes_requested');
  assert.equal(state.reviews.length, 1);
  state.pr.head.sha = oid(3);
  green();
  assert.throws(() => run('verify'), /approved/i);
  state.verdict = 'approved';
  assert.equal(run('review').headSha, oid(3));
  assert.equal(state.reviews.length, 2);
  assert.deepEqual(run('verify').checks.map(c => c.state), ['success', 'success']);
  assert.equal(run('merge').mergeSha, oid(20));
  assert.equal(run('merge').status, 'merged');
  assert.deepEqual(state.writes, [['--method', 'PUT', '-f', 'sha=' + oid(3)]]);
});

test('old base, old HEAD, tampered receipt and policy stop are enforced before the PUT', t => {
  const { state, run, green } = fixture(t);
  run('review');
  state.pr.base.sha = oid(10);
  const stale = run('review-status');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.baseSha, oid(10));
  assert.equal(stale.previous.state, 'approved');
  assert.equal(stale.previous.baseSha, oid(1));
  assert.throws(() => run('verify'), /approved/i);
  state.receiptOverrides = { baseSha: oid(1) };
  assert.throws(() => run('review'), /mismatch/i);
  state.receiptOverrides = {};
  run('review');
  state.policy.integration = 'ready';
  assert.throws(() => run('merge'), /ready/i);
  state.pr.head.sha = oid(12);
  green();
  assert.equal(run('review-status').state, 'stale');
  assert.throws(() => run('verify'), /approved/i);
  assert.equal(state.writes.length, 0);
});

test('failed rerun outranks previous success, ambiguous/missing/wrong-app/queued runs block', t => {
  const { state, run } = fixture(t);
  run('review');
  const original = state.runs[0];
  state.statuses.unshift({ context: 'unit', state: 'failure' });
  assert.throws(() => run('merge'), /unit=failure/);
  state.statuses.shift();
  for (const [runs, reason] of [
    [[], /missing/],
    [[original, { ...original }], /ambiguous/],
    [[{ ...original, app: { id: 8 } }], /missing/],
    [[{ ...original, head_sha: oid(90) }], /missing/],
    [[{ ...original, status: 'in_progress', conclusion: null }], /in_progress/],
    [[{ ...original, conclusion: 'skipped' }], /skipped/],
  ]) {
    state.runs = runs;
    assert.throws(() => run('merge'), reason);
  }
  assert.equal(state.writes.length, 0);
});

test('a new HEAD between snapshots blocks locally; after the snapshots GitHub rejects the stale SHA', t => {
  const { state, run, green } = fixture(t);
  run('review');
  state.afterChecks = () => { state.pr.head.sha = oid(3); };
  assert.throws(() => run('merge'), /changed during verification/i);
  assert.equal(state.writes.length, 0);
  delete state.afterChecks;
  green();
  run('review');
  state.beforePut = () => { state.pr.head.sha = oid(4); };
  assert.throws(() => run('merge'), /409/);
  assert.deepEqual(state.writes[0], ['--method', 'PUT', '-f', 'sha=' + oid(3)]);
  assert.equal(state.pr.merged, false);
});

test('a lost successful merge response reconciles with server state on retry without another write', t => {
  const { state, run } = fixture(t);
  run('review');
  state.afterPut = () => { throw Error('connection lost'); };
  assert.throws(() => run('merge'), /connection lost/);
  const outcome = run('merge');
  assert.equal(outcome.mergeSha, state.pr.merge_commit_sha);
  assert.equal(outcome.state, 'merged');
  assert.equal(outcome.origin, 'server-reconciled');
  // A new invocation reads the persisted origin. A bare server result would say "server".
  assert.deepEqual(run('review-status'), outcome);
  assert.deepEqual(run('merge'), outcome);
  assert.equal(state.writes.length, 1);
});

test('an existing external merge reports the server as origin without a PUT or a local claim', t => {
  const { state, run } = fixture(t);
  Object.assign(state.pr, { state: 'closed', merged: true, merge_commit_sha: oid(56) });
  const merged = run('merge');
  assert.equal(merged.origin, 'server');
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergeSha, oid(56));
  assert.deepEqual(run('review-status'), merged);
  assert.deepEqual(state.reads, [pull, pull]);
  assert.equal(state.writes.length, 0);
});

test('a changed brief at the same base and head gets reviewed; an identical brief reuses its receipt', t => {
  const { state, run, brief } = fixture(t);
  const first = 'Skip duplicate notifications.';
  const second = 'Preserve every notification including duplicates.';
  const sha = text => createHash('sha256').update(text).digest('hex');
  assert.equal(run('review').verdict, 'approved');
  assert.equal(run('review-status').briefSha256, sha(first));
  writeFileSync(brief, second);
  state.verdict = 'changes_requested';
  const changed = run('review');
  assert.equal(changed.verdict, 'changes_requested');
  const recorded = run('review-status');
  assert.equal(recorded.briefSha256, sha(second));
  assert.equal(recorded.round, 2);
  assert.deepEqual(run('review'), changed);
  assert.equal(run('review-status').revision, recorded.revision);
  assert.deepEqual(state.reviews.map(r => [r.brief, r.headSha, r.baseSha]), [
    [first, oid(2), oid(1)], [second, oid(2), oid(1)],
  ]);
});

test('review claims block duplicate dispatch, revision-checked recovery consumes the original attempt', t => {
  const { state, run } = fixture(t);
  state.policy.maxReviewRounds = 2;
  const failDuringReview = () => {
    const claim = run('review-status');
    assert.equal(claim.state, 'reviewing');
    assert.throws(() => run('review'), /in progress/i);
    assert.throws(() => run('recover-review', String(claim.revision + 1)), /interrupted/i);
    assert.equal(run('recover-review', String(claim.revision)).state, 'interrupted');
    throw Error('stale worker');
  };
  // Simulate a late worker losing its claim after an operator recovered the interrupted process.
  assert.throws(() => run('review', undefined, { review: failDuringReview }), /revision conflict/i);
  assert.equal(run('review-status').state, 'interrupted');
  run('review');
  state.pr.head.sha = oid(4);
  assert.throws(() => run('review'), /budget/i);
  assert.equal(state.reviews.length, 1);
});
