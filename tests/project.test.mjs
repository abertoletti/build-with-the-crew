import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { configurationPath, defaults, loadConfig, pluginRoot, resolveConfig, storageDir } from '../plugins/build-with-the-crew/scripts/project.mjs';
import { requireRoleSkills, stageRoleSkills } from '../plugins/build-with-the-crew/scripts/role-skills.mjs';

const execute = promisify(execFile);
const command = join(pluginRoot, 'scripts', 'method.mjs');

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crew-project-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const main = join(dir, 'main repo');
  mkdirSync(main);
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  git(main, 'init', '-q', '-b', 'main');
  const cli = async (cwd, ...args) => {
    const response = await execute(process.execPath, [command, ...args], { cwd, windowsHide: true });
    return JSON.parse(response.stdout);
  };
  return { dir, main, git, cli };
}

test('init creates a valid portable config and preserves an existing edited file on retry', async t => {
  const { main, cli } = repository(t);
  const created = await cli(main, 'init', 'example/test', 'main');
  assert.equal(created.path, join(main, '.build-with-the-crew', 'config.json'));
  const path = join(main, configurationPath);
  const raw = JSON.parse(readFileSync(path));
  raw.integration = 'merge';
  raw.requiredChecks = [{ type: 'check', name: 'unit', appId: 7 }];
  raw.roles.review = { model: 'sonnet', skills: ['code-review-excellence'] };
  const edited = '\uFEFF' + JSON.stringify(raw, null, 3) + '\n';
  writeFileSync(path, edited);
  await assert.rejects(cli(main, 'init', 'different/project', 'trunk'), /already exists/i);
  assert.equal(readFileSync(path, 'utf8'), edited);
  const config = await cli(main, 'config');
  assert.equal(config.roles.review.model, 'sonnet');
  assert.deepEqual(config.roles.ux.skills, ['impeccable']);
  assert.deepEqual(config.requiredChecks, raw.requiredChecks);
  await assert.rejects(cli(main, 'init', 'example/test'));
});

test('project validation rejects malformed and duplicate skills, invalid branches, implicit merge and duplicate checks', () => {
  const base = defaults('example/test', 'main');
  for (const override of [
    { roles: { review: { skills: ['project:../outside'] } } },
    { roles: { review: { skills: ['code-review-excellence'], optionalSkills: ['project:code-review-excellence'] } } },
    { baseBranch: '../outside' }, { integration: 'merge' }, { maxReviewRounds: 0 },
    { requiredChecks: [{ type: 'status', name: 'tests' }, { type: 'status', name: 'TESTS' }] },
    { requiredChecks: [{ type: 'status', name: 'tests', appId: 42 }] },
  ]) assert.throws(() => resolveConfig({ ...base, ...override }));
});

test('doctor detects missing required and optional skills in a fresh checkout and resolves installed project skills', async t => {
  const { main, cli } = repository(t);
  await cli(main, 'init', 'example/test', 'main');
  const first = await cli(main, 'doctor');
  assert.equal(first.roles.length, 6);
  assert.ok(first.roles.every(role => role.status === 'ready'));
  const config = { ...defaults('example/test', 'main'), roles: {
    developer: { skills: ['test-driven-development', 'project:release-checklist'], optionalSkills: ['project:performance-tips'] },
  } };
  writeFileSync(join(main, configurationPath), JSON.stringify(config));
  await assert.rejects(cli(main, 'doctor', 'developer'), error => {
    const [developer] = JSON.parse(error.stdout).roles;
    assert.equal(error.code, 1);
    assert.equal(developer.status, 'blocked');
    assert.deepEqual(developer.problems.map(p => [p.skill, p.required]), [
      ['project:release-checklist', true], ['project:performance-tips', false],
    ]);
    return true;
  });
  assert.equal((await cli(main, 'doctor', 'qa')).roles[0].status, 'ready');
  const directory = join(main, '.agents', 'skills', 'release-checklist');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: release-checklist\n---\nCheck the release.\n');
  const [developer] = (await cli(main, 'doctor', 'developer')).roles;
  assert.equal(developer.status, 'warning');
  assert.deepEqual(developer.available.map(skill => skill.name), ['test-driven-development', 'release-checklist']);
});

test('project review skills and resources are staged from the trusted PR base', t => {
  const { dir, main, git } = repository(t);
  const skill = join(main, '.agents', 'skills', 'trusted-review');
  mkdirSync(join(skill, 'references'), { recursive: true });
  const body = '---\nname: trusted-review\n---\nRead the project standard.\n';
  writeFileSync(join(skill, 'SKILL.md'), body);
  writeFileSync(join(skill, 'references', 'standard.md'), 'Base standard.');
  git(main, 'add', '.agents/skills/trusted-review');
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'trusted skill');
  const base = git(main, 'rev-parse', 'HEAD').trim();
  writeFileSync(join(skill, 'SKILL.md'), 'Proposed PR content.');
  writeFileSync(join(skill, 'references', 'standard.md'), 'Proposed PR changes.');
  const role = { skills: ['project:trusted-review'] };
  const report = requireRoleSkills(main, 'review', role, base);
  const destination = join(dir, 'staged');
  stageRoleSkills(main, report.available, destination);
  assert.equal(readFileSync(join(destination, 'trusted-review', 'SKILL.md'), 'utf8'), body);
  assert.equal(readFileSync(join(destination, 'trusted-review', 'references', 'standard.md'), 'utf8'), 'Base standard.');
  assert.throws(() => requireRoleSkills(main, 'review', { skills: ['project:uncommitted-skill'] }, base), /missing from the trusted base/);
});

test('role efforts are independent, optional and validated for the target runtime', () => {
  const base = defaults('example/test', 'main');
  const roles = {
    coordinator: { effort: 'medium' }, task: { effort: 'low' }, developer: { effort: 'ultra' },
    ux: { model: 'opus', effort: 'medium' }, review: { model: 'opus', effort: 'high' },
  };
  const effective = resolveConfig({ ...base, roles }).roles;
  for (const [name, role] of Object.entries(roles)) assert.equal(effective[name].effort, role.effort);
  assert.equal(effective.qa.effort, undefined);
  for (const effort of [null, 1, 'ultra', 'high\nmodel: haiku']) {
    assert.throws(() => resolveConfig({ ...base, roles: { ux: { effort } } }), /effort/i);
  }
});

test('the base revision retains its CI policy when a proposed change relaxes it', t => {
  const { main, git } = repository(t);
  const path = join(main, configurationPath);
  mkdirSync(join(main, '.build-with-the-crew'));
  const policy = { ...defaults('example/test', 'main'), requiredChecks: [{ type: 'status', name: 'full-suite' }] };
  writeFileSync(path, JSON.stringify(policy));
  git(main, 'add', '--', configurationPath);
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'policy on base');
  const base = git(main, 'rev-parse', 'HEAD').trim();
  writeFileSync(path, JSON.stringify({ ...policy, requiredChecks: [] }));
  assert.deepEqual(loadConfig(main).requiredChecks, []);
  assert.deepEqual(loadConfig(main, base).requiredChecks, [{ type: 'status', name: 'full-suite' }]);
});

test('new journals use the English path and existing projects retain their checkpoints', async t => {
  const { dir, main, cli } = repository(t);
  assert.equal(storageDir(main).split(/[\\/]/).at(-1), 'build-with-the-crew');
  mkdirSync(join(main, '.git', 'metodo'));
  const note = join(dir, 'legacy-note.txt');
  writeFileSync(note, 'Resume the existing task.\n');
  await cli(main, 'checkpoint', 'preview-task', '0', 'assigned', note);
  const legacyRecord = join(main, '.git', 'metodo', 'tasks', 'task-preview-task', '0000000001', 'record.json');
  assert.equal(JSON.parse(readFileSync(legacyRecord)).stage, 'assigned');
  assert.equal((await cli(main, 'status', 'preview-task')).revision, 1);
});

test('two worktrees race on a checkpoint, resume from the winner and keep other tasks independent', async t => {
  const { dir, main, git, cli } = repository(t);
  git(main, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-qm', 'fixture');
  const other = join(dir, 'second worktree');
  git(main, 'worktree', 'add', '-q', '-b', 'task-b', other);
  const note = join(dir, 'note.txt');
  writeFileSync(note, 'Resume from the saved task brief.\n');
  assert.equal(await cli(main, 'status', 'a'), null);
  assert.deepEqual(await cli(other, 'history', 'a'), []);
  const append = (cwd, id, rev, stage) => cli(cwd, 'checkpoint', id, String(rev), stage, note);
  const contenders = await Promise.allSettled([append(main, 'a', 0, 'assigned'), append(other, 'a', 0, 'assigned')]);
  assert.equal(contenders.filter(entry => entry.status === 'fulfilled').length, 1);
  assert.match(contenders.find(entry => entry.status === 'rejected').reason.message, /concurrent|conflict/i);
  await append(main, 'a', 1, 'waiting-human');
  await append(other, 'b', 0, 'assigned');
  await append(other, 'b', 1, 'working');
  const saved = await cli(other, 'status', 'a');
  assert.equal(saved.stage, 'waiting-human');
  assert.equal(saved.note, 'Resume from the saved task brief.');
  await append(other, 'a', saved.revision, 'working');
  await assert.rejects(append(main, 'a', 2, 'cancelled'), /conflict/i);
  await append(main, 'a', 3, 'cancelled');
  await assert.rejects(append(other, 'a', 4, 'working'), /closed/i);
  assert.deepEqual((await cli(main, 'history', 'a')).map(r => r.revision), [1, 2, 3, 4]);
  assert.equal((await cli(main, 'status', 'b')).stage, 'working');
  await assert.rejects(cli(main, 'status', '../a'));
});
