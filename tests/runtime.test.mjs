import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { invokeSpecialist, receiptFor, validModel, validateRuntimeName } from '../plugins/metodo/scripts/runtime.mjs';

const fakeProgram = `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [trace, literal, behaviorFile, requestFile] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(requestFile));
const behavior = fs.readFileSync(behaviorFile, 'utf8');
const files = input.files.map(name => fs.readFileSync(path.join(input.cwd, name)).toString('hex'));
const skillsPresent = input.skills.every(name => fs.existsSync(path.join(input.skillRoot, name, 'SKILL.md')));
const patch = input.diffPath ? fs.readFileSync(input.diffPath) : null;
fs.appendFileSync(trace, JSON.stringify({ input, literal, files, skillsPresent, patch: patch?.toString(),
  processDir: process.cwd(), staged: fs.readdirSync(input.cwd) }) + '\\n');
const result = { role:input.role, requestedModel:input.model, model:'vendor/model-2026-11', skills:input.skills,
  sessionId:'provider-session-42', agentToolUseId:'provider-job-1', summary:'Assessment result' };
if (patch) Object.assign(result, {baseSha:input.baseSha,headSha:input.headSha,verdict:'approved',
  diffSha256:crypto.createHash('sha256').update(patch).digest('hex')});
if (behavior === 'wrong-diff') result.diffSha256 = 'a'.repeat(64);
if (behavior === 'wrong-head') result.headSha = 'f'.repeat(40);
if (behavior === 'wrong-skills') result.skills = ['wrong'];
if (behavior === 'missing-id') delete result.sessionId;
if (behavior === 'no-model') result.model = ' ';
if (behavior === 'malformed') process.stdout.write('not a receipt');
else process.stdout.write(JSON.stringify(result));
`;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'metodo external adapter '));
  const project = join(root, 'project under review');
  const registry = join(root, 'registered adapters.json');
  const wrapper = join(root, 'test adapter.cjs');
  const trace = join(root, 'requests.jsonl');
  const behavior = join(root, 'behavior.txt');
  const literal = 'argument with spaces & | $x';
  const registration = { command: process.execPath, args: [wrapper, trace, literal, behavior] };
  function register(entry = registration) {
    writeFileSync(registry, JSON.stringify({ version: 1, adapters: { 'test-cli': entry } }));
  }
  const previous = process.env.METODO_ADAPTERS_FILE;
  process.env.METODO_ADAPTERS_FILE = registry;
  t.after(() => {
    if (previous === undefined) delete process.env.METODO_ADAPTERS_FILE;
    else process.env.METODO_ADAPTERS_FILE = previous;
    rmSync(root, { recursive: true, force: true, maxRetries: 4 });
  });
  mkdirSync(project);
  writeFileSync(wrapper, fakeProgram);
  writeFileSync(behavior, 'valid');
  register();
  const records = () => existsSync(trace)
    ? readFileSync(trace, 'utf8').trimEnd().split('\n').map(s => JSON.parse(s)) : [];
  return { project, trace, registry, behavior, literal, register, records };
}

function ux(project) {
  return { role: 'ux', model: 'vendor/model:latest', skills: ['impeccable'], cwd: project,
    brief: 'Review the pickup form', context: 'Synthetic project', files: ['screen.png'] };
}

test('model and runtime validation distinguish the built-in CLI from explicit external registrations', () => {
  for (const name of ['other-cli', 'claude-code']) assert.equal(validateRuntimeName(name), name);
  for (const name of ['../cli', '', null, 'app.exe -x']) assert.throws(() => validateRuntimeName(name));
  assert.ok(validModel('claude-code', 'opus'));
  assert.ok(validModel('claude-code', 'claude-opus-5-5'));
  assert.equal(validModel('claude-code', 'vendor/model'), false);
  assert.ok(validModel('test-cli', 'vendor/model:version@latest'));
  assert.equal(validModel('test-cli', '--program'), false);
  assert.equal(validModel('../test-cli', 'any'), false);
});

test('a registered process receives only selected UX files, packaged skills and literal arguments', t => {
  const f = setup(t);
  const pixels = Buffer.from([137, 80, 78, 71]);
  writeFileSync(join(f.project, 'screen.png'), pixels);
  writeFileSync(join(f.project, 'private.txt'), 'not selected');
  const request = { ...ux(f.project), command: 'ignore-me', args: ['ignore-me'], skillRoot: 'ignore-me' };
  const receipt = invokeSpecialist(request, 'test-cli');
  assert.equal(receipt.runtime, 'test-cli');
  assert.equal(receipt.model, 'vendor/model-2026-11');
  assert.equal(receipt.requestedModel, request.model);
  const [log] = f.records();
  assert.equal(log.literal, f.literal);
  assert.equal(log.input.adapterProtocol, 1);
  assert.notEqual(log.input.cwd, f.project);
  assert.ok(!JSON.stringify(log.input).includes(f.project.replaceAll('\\', '\\\\')));
  assert.ok(!Object.hasOwn(log.input, 'command'));
  assert.equal(log.input.runtime, 'test-cli');
  assert.deepEqual(log.staged, log.input.files);
  assert.deepEqual(log.files, [pixels.toString('hex')]);
  assert.ok(log.skillsPresent);
  assert.ok(!existsSync(log.processDir), 'remove the per-invocation working directory');
});

test('the public UX receipt preserves the bundled specialist evidence and never attributes external claims to it', () => {
  const input = { role: 'ux', model: 'opus', skills: ['impeccable'] };
  const verified = { verifiedInputs: 3, deliveredImages: 1, referencesRead: ['impeccable/reference/critique.md'] };
  const result = { role: 'ux', requestedModel: 'opus', model: 'claude-opus-5-5', skills: input.skills,
    sessionId: 'claude-session', agentToolUseId: 'agent-call', summary: 'Usability findings.',
    evidence: { ...verified, unrelated: 'omit from public report' } };
  assert.deepEqual(receiptFor(result, input, 'claude-code').evidence, verified);
  assert.throws(() => receiptFor(result, { ...input, effort: 'high' }, 'external-cli'), /receipt/i);
  assert.throws(() => receiptFor({ ...result, requestedEffort: 'low' }, { ...input, effort: 'high' }, 'external-cli'), /receipt/i);
  assert.ok(!Object.hasOwn(receiptFor(result, input, 'external-cli'), 'evidence'));
  for (const evidence of [undefined, { ...verified, deliveredImages: 0 }, { ...verified, verifiedInputs: 0 },
    { ...verified, referencesRead: [{}] }]) {
    assert.throws(() => receiptFor({ ...result, evidence }, input, 'claude-code'), /verified UX evidence/);
  }
});

test('invalid registry, missing skills and out-of-worktree attachments fail before starting a process', t => {
  const f = setup(t);
  const request = ux(f.project);
  writeFileSync(join(f.project, 'screen.png'), 'synthetic');
  assert.throws(() => invokeSpecialist(request, 'missing'), /unregistered/i);
  assert.throws(() => invokeSpecialist(request, '../adapter'), /runtime name/i);
  f.register({ command: 'node', args: [] });
  assert.throws(() => invokeSpecialist(request, 'test-cli'), /absolute command/i);
  f.register({ command: process.execPath, args: 'node some-script' });
  assert.throws(() => invokeSpecialist(request, 'test-cli'), /literal arguments/i);
  f.register();
  assert.throws(() => invokeSpecialist({ ...request, files: ['screen.png', '../behavior.txt'] }, 'test-cli'), /outside/i);
  assert.throws(() => invokeSpecialist({ ...request, skills: ['missing-skill'] }, 'test-cli'), /packaged skill/i);
  process.env.METODO_ADAPTERS_FILE = './registered-adapters.json';
  assert.throws(() => invokeSpecialist(request, 'test-cli'), /absolute METODO_ADAPTERS_FILE/i);
  assert.deepEqual(f.records(), []);
});

test('an external review is bound to the local PR patch and rejects incomplete or stale receipts', t => {
  const f = setup(t);
  const git = (...args) => execFileSync('git', ['-C', f.project,
    '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(f.project, 'feature.txt'), 'unique changed line\n');
  git('add', 'feature.txt');
  git('commit', '-q', '-m', 'feature');
  const head = git('rev-parse', 'HEAD');
  const request = { role: 'review', cwd: f.project, model: 'vendor/model:latest', skills: ['code-review-excellence'],
    brief: 'Review this change', baseSha: base, headSha: head };
  const receipt = invokeSpecialist(request, 'test-cli');
  assert.equal(receipt.verdict, 'approved');
  assert.equal(receipt.headSha, head);
  assert.equal(receipt.baseSha, base);
  assert.match(f.records()[0].patch, /^\+unique changed line$/m);
  assert.equal(f.records()[0].input.diffSha256, receipt.diffSha256);
  for (const failure of ['wrong-diff', 'wrong-head', 'wrong-skills', 'missing-id', 'no-model', 'malformed']) {
    writeFileSync(f.behavior, failure);
    assert.throws(() => invokeSpecialist(request, 'test-cli'), /receipt/i, failure);
  }
  assert.equal(f.records().length, 7);
});
