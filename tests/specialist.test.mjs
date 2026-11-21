import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRequest, stage, verify } from '../plugins/build-with-the-crew/scripts/specialist.mjs';

function fixture(t, role = 'review', effort) {
  const root = mkdtempSync(join(tmpdir(), 'crew-specialist-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), directory = join(root, 'isolated');
  const skill = role === 'review' ? 'code-review-excellence' : 'impeccable';
  const skillRoot = join(root, 'sources'), source = join(skillRoot, skill);
  mkdirSync(join(source, 'reference'), { recursive: true });
  mkdirSync(join(source, 'references'));
  writeFileSync(join(source, 'SKILL.md'), '---\nname: ' + skill + '\ndescription: Test\n---\nApply the test skill.\n');
  writeFileSync(join(source, 'reference/test.md'), 'Look for visible or reproducible defects.');
  writeFileSync(join(source, 'references/review-techniques.md'), 'Assess the real change.');
  mkdirSync(cwd);
  const input = { role, cwd, effort, brief: 'Review the change.', context: 'Synthetic context for the test.' };
  if (role === 'review') {
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=local@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q');
    writeFileSync(join(cwd, 'app.txt'), 'before\n');
    git('add', 'app.txt');
    git('commit', '-qm', 'initial');
    input.baseSha = git('rev-parse', 'HEAD');
    writeFileSync(join(cwd, 'app.txt'), 'after\n');
    git('add', 'app.txt');
    git('commit', '-qm', 'feature');
    input.headSha = git('rev-parse', 'HEAD');
  } else {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOw3RYQAAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(cwd, 'screen.png'), png);
    input.files = ['screen.png'];
  }
  return { job: stage(readRequest(input), directory, skillRoot), input, source };
}

// A local provider replay keeps routine changes testable without account credentials.
function trace(job, verdict = 'approved') {
  const session = 'test-session', parent = 'agent-invocation';
  const message = (type, content, child = true) => ({
    type, session_id: session, parent_tool_use_id: child ? parent : null,
    message: { model: child ? 'claude-opus-5-5' : 'claude-haiku-4-5', content }
  });
  const events = [
    { type: 'system', subtype: 'init', session_id: session, mcp_servers: [], agents: [job.agent], skills: job.skills.map(s => 'crew-local:' + s) },
    message('assistant', [{ type: 'tool_use', name: 'Agent', id: parent, input: { subagent_type: job.agent } }], false),
    message('assistant', [{ type: 'text', text: job.receipts.join(' ') }])
  ];
  function read(name, path, content) {
    events.push(message('assistant', [{ type: 'tool_use', id: name, name: 'Read', input: { file_path: path } }]));
    events.push(message('user', [{ type: 'tool_result', tool_use_id: name, content }]));
  }
  for (const input of job.inputs) {
    const path = join(job.directory, input.name);
    const content = input.image ? [{ type: 'image', source: { type: 'base64', data: readFileSync(path).toString('base64'), media_type: 'image/png' } }]
      : readFileSync(path, 'utf8').split('\n').map((s, i) => i + 1 + '\t' + s).join('\n');
    read(input.name, path, content);
  }
  if (job.role === 'ux') read('guide', join(job.plugin, 'skills/impeccable/reference/test.md'), '1\tLook for visible or reproducible defects.');
  else read('techniques', join(job.plugin, 'skills/code-review-excellence/references/review-techniques.md'), '1\tAssess the real change.');
  const body = job.role === 'ux' ? 'Screenshot finding.' : JSON.stringify({ verdict, headSha: job.headSha, summary: 'Reproduction and evidence.' });
  events.push(
    message('assistant', [{ type: 'text', text: body }]),
    message('user', [{ type: 'tool_result', tool_use_id: parent, content: 'Finished' }], false),
    { type: 'result', subtype: 'success', is_error: false, session_id: session }
  );
  return events;
}

test('Claude role effort goes into the child definition and conflicting dispatch overrides fail', t => {
  const { job } = fixture(t, 'ux', 'medium');
  const definition = readFileSync(join(job.plugin, 'agents', 'ux.md'), 'utf8');
  assert.match(definition, /^effort: medium$/m);
  const events = trace(job);
  assert.equal(verify(events, job).requestedEffort, 'medium');
  events[1].message.content[0].input.effort = 'low';
  assert.throws(() => verify(events, job), /delegate/i);
});

test('returns the actual child verdict, identity and digest of the full Git diff, including rejection', t => {
  const { job, source } = fixture(t);
  assert.match(job.inputs[0].content, /-before\n\+after/);
  assert.ok(!readFileSync(join(source, 'SKILL.md'), 'utf8').includes(job.receipts[0]));
  for (const verdict of ['approved', 'changes_requested']) {
    const result = verify(trace(job, verdict), job);
    assert.equal(result.verdict, verdict);
    assert.equal(result.headSha, job.headSha);
    assert.equal(result.model, 'claude-opus-5-5');
    assert.match(result.diffSha256, /^[a-f0-9]{64}$/);
  }
  const marked = trace(job, 'changes_requested');
  const last = marked.at(-3).message.content[0];
  last.text = 'Detailed explanation.\nCREW_VERDICT ' + last.text;
  assert.equal(verify(marked, job).verdict, 'changes_requested');
  last.text += '\nI retract the verdict.';
  assert.throws(() => verify(marked, job), /Ambiguous/);
});

test('rejects an unverified model, missing skill, stale head, missing evidence, failed CLI or forged parent summary', t => {
  const { job } = fixture(t);
  const mutations = [
    e => { e[2].message.model = 'claude-haiku-4-5'; },
    e => { e[2].message.model = 'claude-opus-impostor'; },
    e => { e[0].skills = []; },
    e => { e[2].message.content[0].text = 'Ready'; },
    e => { e[2].parent_tool_use_id = 'wrong-agent'; },
    e => { e[4].message.content[0].content = 'truncated response'; },
    e => { e.at(-3).message.content[0].text = JSON.stringify({ verdict: 'approved', headSha: job.baseSha, summary: 'ok' }); },
    e => { e.at(-3).parent_tool_use_id = null; },
    e => { e.find(item => item.message?.content[0]?.tool_use_id === 'techniques').message.content[0].is_error = true; },
    e => { e.at(-1).is_error = true; },
    e => { e.pop(); }
  ];
  for (const mutate of mutations) {
    const events = trace(job);
    mutate(events);
    assert.throws(() => verify(events, job));
  }
});

test('UX requires actual image delivery and a successful Impeccable reference read', t => {
  const { job } = fixture(t, 'ux');
  const events = trace(job);
  assert.equal(verify(events, job).summary, 'Screenshot finding.');
  const ref = events.find(e => e.message?.content[0].tool_use_id === 'guide');
  ref.message.content[0].is_error = true;
  assert.throws(() => verify(events, job), /playbook/);
  ref.message.content[0].is_error = false;
  const png = events.find(e => e.message?.content[0].tool_use_id?.endsWith('.png'));
  png.message.content[0].content = 'there is a screenshot here';
  assert.throws(() => verify(events, job), /input evidence/);
});

test('rejects missing SHA, unsupported model, material outside the worktree, and wrong worktree HEAD before contacting Claude', t => {
  const { input, job, source } = fixture(t);
  assert.throws(() => readRequest({ ...input, headSha: null }), /headSha/);
  assert.throws(() => readRequest({ ...input, model: '' }), /model/);
  assert.throws(() => readRequest({ ...input, skills: ['../../unsafe'] }), /skill/);
  const sources = join(source, '..');
  assert.throws(() => stage(readRequest({ ...input, headSha: input.baseSha }), join(job.directory, 'mismatch'), sources), /HEAD/);
  assert.throws(() => stage(readRequest({ ...input, files: ['../sources/code-review-excellence/SKILL.md'] }), join(job.directory, 'outside'), sources), /inside cwd/);
  assert.throws(() => stage(readRequest({ ...input, skills: ['missing'] }), join(job.directory, 'missing'), sources));
});
