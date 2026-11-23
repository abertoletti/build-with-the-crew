import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const method = fileURLToPath(new URL('../plugins/build-with-the-crew/scripts/method.mjs', import.meta.url));

test('the coordinator imports a decision from an isolated journal and retains the answer until confirmed', t => {
  const root = mkdtempSync(join(tmpdir(), 'crew-decisions-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const makeRepo = name => {
    const cwd = join(root, name);
    execFileSync('git', ['init', '-q', cwd]);
    return (...args) => JSON.parse(execFileSync(process.execPath, [method, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }));
  };
  const coordinator = makeRepo('coordinator'), worker = makeRepo('cloud-worker');
  const task = 'landing', decision = 'hero-style';
  const write = (name, value) => {
    const path = join(root, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const note = write('note', 'Prepare two options for the landing.');
  coordinator('checkpoint', task, '0', 'assigned', note);
  const route = { hostId: 'durable', threadId: 'cloud-chat-1' };
  coordinator('checkpoint', task, '1', 'working', note, write('route.json', route));
  coordinator('checkpoint', 'login', '0', 'assigned', note);
  worker('checkpoint', task, '0', 'assigned', note);
  const body = { question: 'Which hero should we use?', options: ['Step player', 'Folder'], recommendation: 'Step player' };
  const workerRequest = write('worker-request.json', body);
  worker('decision-request', task, decision, workerRequest);
  worker('checkpoint', task, '1', 'waiting-human', note);
  assert.deepEqual(coordinator('decisions'), []);
  assert.deepEqual(coordinator('open-tasks').find(item => item.taskId === task), { taskId: task, stage: 'working', ...route });
  const request = write('request.json', { ...worker('decisions')[0].request, ...route });
  const pending = coordinator('decision-request', task, decision, request);
  assert.equal(pending.state, 'pending');
  assert.deepEqual(coordinator('decision-request', task, decision, request), pending);
  assert.equal(coordinator('decisions')[0].request.threadId, 'cloud-chat-1');
  assert.equal(coordinator('status', 'login').stage, 'assigned');
  assert.throws(() => coordinator('decision-ack', task, decision), /Record the answer/);
  const answer = write('answer', 'Step player');
  const answered = coordinator('decision-answer', task, decision, answer);
  assert.deepEqual(coordinator('decision-answer', task, decision, answer), answered);
  assert.equal(coordinator('decisions')[0].state, 'answered');
  assert.throws(() => coordinator('decision-answer', task, decision, write('different', 'Folder')), /different answer/);
  worker('decision-answer', task, decision, answer);
  worker('decision-ack', task, decision);
  worker('checkpoint', task, '2', 'working', note);
  const acknowledged = coordinator('decision-ack', task, decision);
  assert.deepEqual(coordinator('decision-ack', task, decision), acknowledged);
  assert.deepEqual(coordinator('decisions'), []);
  assert.equal(worker('status', task).stage, 'working');
});
