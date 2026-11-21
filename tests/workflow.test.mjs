import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marketplace = fileURLToPath(new URL('../', import.meta.url));
const catalog = JSON.parse(readFileSync(join(marketplace, '.agents/plugins/marketplace.json')));
const plugin = resolve(marketplace, catalog.plugins.find(entry => entry.name === 'build-with-the-crew').source.path);
const { managePull } = await import(pathToFileURL(join(plugin, 'scripts/pull-request.mjs')).href);

const reviewer = `
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const [journal, requestFile] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestFile));
const patch = fs.readFileSync(request.diffPath);
const zeroAllowed = patch.toString().includes('+export const canOrder = quantity => quantity >= 0;');
fs.appendFileSync(journal, request.headSha + '\\n');
console.log(JSON.stringify({role:'review',requestedModel:request.model,model:'fixture-reviewer-1',requestedEffort:request.effort,
  skills:request.skills,baseSha:request.baseSha,headSha:request.headSha,
  diffSha256:createHash('sha256').update(patch).digest('hex'),
  verdict:zeroAllowed?'changes_requested':'approved', summary:zeroAllowed?'Reject zero quantities.':'Zero quantities are rejected.',
  sessionId:'fixture-session-'+request.headSha,agentToolUseId:'fixture-job-'+request.headSha}));
`;

test('a task worktree uses the base policy and an external reviewer through correction, QA and merge', t => {
  const root = mkdtempSync(join(tmpdir(), 'crew workflow '));
  const previous = process.env.CREW_ADAPTERS_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.CREW_ADAPTERS_FILE;
    else process.env.CREW_ADAPTERS_FILE = previous;
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const main = join(root, 'coordinator');
  const task = join(root, 'task worktree');
  mkdirSync(main);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { encoding: 'utf8', windowsHide: true }).trim();
  const cli = (cwd, ...args) => JSON.parse(execFileSync(process.execPath, [join(plugin, 'scripts/method.mjs'), ...args],
    { cwd, encoding: 'utf8', windowsHide: true }));
  const brief = join(root, 'assignment.txt');
  writeFileSync(brief, 'Allow positive order quantities. Reject zero.');
  const journal = join(root, 'review-journal.txt');
  const adapter = join(root, 'quantity reviewer.cjs');
  writeFileSync(adapter, reviewer);
  const registry = join(root, 'adapters.json');
  writeFileSync(registry, JSON.stringify({ version: 1, adapters: {
    'quantity-reviewer': { command: process.execPath, args: [adapter, journal] },
  } }));
  process.env.CREW_ADAPTERS_FILE = registry;

  const repository = 'example/quantities';
  git(main, 'init', '-q', '-b', 'main');
  const config = cli(main, 'init', repository, 'main').path;
  const policy = JSON.parse(readFileSync(config));
  Object.assign(policy, { integration: 'merge', mergeMethod: 'merge', testCommands: ['node --test quantity.test.mjs'],
    requiredChecks: [{ type: 'check', name: 'test', appId: 7 }],
    roles: { review: { model: 'fixture', effort: 'high', runtime: 'quantity-reviewer', skills: ['code-review-excellence'] } } });
  writeFileSync(config, JSON.stringify(policy));
  git(main, 'add', '.build-with-the-crew/config.json');
  git(main, 'commit', '-qm', 'Set project policy');
  const base = git(main, 'rev-parse', 'HEAD');
  cli(main, 'checkpoint', 'quantities', '0', 'assigned', brief);
  git(main, 'worktree', 'add', '-q', '-b', 'task/quantities', task, base);
  assert.equal(cli(task, 'status', 'quantities').stage, 'assigned');
  cli(task, 'checkpoint', 'quantities', '1', 'working', brief);
  const implementation = join(task, 'quantity.mjs');
  writeFileSync(implementation, 'export const canOrder = quantity => quantity >= 0;\n');
  const positiveTest = "import assert from 'node:assert/strict';\nimport {canOrder} from './quantity.mjs';\nassert.equal(canOrder(1), true);\n";
  const tests = join(task, 'quantity.test.mjs');
  writeFileSync(tests, positiveTest);
  const qaEnv = { ...process.env };
  // This separate project runs its own suite even when the plugin suite is already a Node test worker.
  delete qaEnv.NODE_TEST_CONTEXT;
  const qa = () => spawnSync(process.execPath, ['--test', 'quantity.test.mjs'], { cwd: task, env: qaEnv, windowsHide: true });
  assert.equal(qa().status, 0);
  git(task, 'add', 'quantity.mjs', 'quantity.test.mjs');
  git(task, 'commit', '-qm', 'Implement ordering');
  const first = git(task, 'rev-parse', 'HEAD');
  // A local task edit must not select the provider or integration policy for its own review.
  writeFileSync(join(task, '.build-with-the-crew/config.json'), JSON.stringify({ ...policy, integration: 'ready',
    roles: { review: { runtime: 'unregistered', model: 'wrong-model' } } }));

  const pr = { state: 'open', draft: false, merged: false, base: { sha: base, ref: 'main', repo: { full_name: repository } },
    head: { sha: first } };
  let green = true, merges = 0;
  const gitHub = (path, ...args) => {
    if (path === 'repos/' + repository + '/pulls/1') return structuredClone(pr);
    if (path === 'repos/' + repository + '/commits/' + pr.head.sha + '/check-runs?filter=latest&per_page=100') {
      return [{ check_runs: [{ name: 'test', app: { id: 7 }, head_sha: pr.head.sha, status: 'completed',
        conclusion: green ? 'success' : 'failure' }] }];
    }
    assert.equal(path, 'repos/' + repository + '/pulls/1/merge');
    assert.deepEqual(args, ['--method', 'PUT', '-f', 'sha=' + pr.head.sha, '-f', 'merge_method=merge']);
    git(main, 'merge', '--no-ff', '-qm', 'Integrate reviewed change', pr.head.sha);
    merges++;
    Object.assign(pr, { state: 'closed', merged: true, merge_commit_sha: git(main, 'rev-parse', 'HEAD') });
    throw new Error('Simulated connection loss after the server accepted the merge.');
  };
  const run = action => managePull(action, repository, '1', brief, { cwd: task, request: gitHub });
  const firstReview = run('review');
  assert.equal(firstReview.verdict, 'changes_requested');
  assert.equal(firstReview.headSha, first);
  assert.deepEqual(run('review'), firstReview);
  assert.throws(() => run('merge'), /approved|changes/i);
  assert.equal(merges, 0);

  writeFileSync(tests, positiveTest + 'assert.equal(canOrder(0), false);\n');
  assert.equal(qa().status, 1, 'the regression test fails on the rejected revision');
  writeFileSync(implementation, 'export const canOrder = quantity => quantity > 0;\n');
  assert.equal(qa().status, 0);
  git(task, 'add', 'quantity.mjs', 'quantity.test.mjs');
  git(task, 'commit', '-qm', 'Reject zero quantities with regression coverage');
  const fixed = git(task, 'rev-parse', 'HEAD');
  pr.head.sha = fixed;
  assert.equal(run('review-status').state, 'stale');
  assert.throws(() => run('merge'), /approved/i);
  const accepted = run('review');
  assert.equal(accepted.verdict, 'approved');
  assert.equal(accepted.headSha, fixed);
  assert.equal(accepted.requestedEffort, 'high');
  assert.notEqual(accepted.diffSha256, firstReview.diffSha256);
  assert.deepEqual(readFileSync(journal, 'utf8').trim().split('\n'), [first, fixed]);
  green = false;
  assert.throws(() => run('merge'), /test=failure/);
  assert.equal(merges, 0);
  green = true;
  assert.equal(run('verify').status, 'ready');
  assert.throws(() => run('merge'), /connection loss/);
  assert.equal(run('review-status').state, 'merged');
  const integrated = run('merge');
  assert.equal(integrated.origin, 'server-reconciled');
  assert.equal(integrated.mergeSha, git(main, 'rev-parse', 'HEAD'));
  assert.equal(git(main, 'rev-parse', 'HEAD^2'), fixed);
  assert.deepEqual(run('review-status'), integrated);
  assert.equal(merges, 1);
  cli(task, 'checkpoint', 'quantities', '2', 'merged', brief);
  assert.equal(cli(main, 'status', 'quantities').stage, 'merged');
});
