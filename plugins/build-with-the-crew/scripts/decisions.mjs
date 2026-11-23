import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendRecord, latestRecord, storageDir, taskDirectory } from './project.mjs';

const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const routeId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/;

function inputFile(path) {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text || Buffer.byteLength(text) > 32768) throw new Error('Expected 1 to 32768 bytes of decision input.');
  return text;
}

function requestFrom(path) {
  const data = JSON.parse(inputFile(path));
  const allowed = ['question', 'options', 'recommendation', 'threadId', 'hostId'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.includes(key))) {
    throw new Error('Invalid decision request.');
  }
  const { question, options = [], recommendation, threadId, hostId } = data;
  const validText = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;
  if (!validText(question, 2000) || !Array.isArray(options) || options.length > 8 ||
      options.some(option => !validText(option, 500)) || new Set(options).size !== options.length ||
      (recommendation !== undefined && !validText(recommendation, 500)) ||
      (hostId === undefined) !== (threadId === undefined) ||
      (threadId !== undefined && (typeof threadId !== 'string' || typeof hostId !== 'string' || !routeId.test(threadId) || !routeId.test(hostId)))) {
    throw new Error('Invalid decision question, options, recommendation or chat route.');
  }
  return { question, options, recommendation, threadId, hostId };
}

function folders(dir, prefix) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix) && slug.test(entry.name.slice(prefix.length)))
      .map(entry => entry.name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

function unfinishedTasks(cwd) {
  const tasks = join(storageDir(cwd), 'tasks');
  return folders(tasks, 'task-').map(task => {
    const directory = join(tasks, task);
    return { directory, record: latestRecord(directory) };
  }).filter(({ record }) => record && record.stage !== 'merged' && record.stage !== 'cancelled');
}

export function openTasks(cwd) {
  return unfinishedTasks(cwd).filter(({ record }) => record.stage !== 'ready').map(({ record }) => ({
    taskId: record.id, stage: record.stage, threadId: record.dashboard?.threadId, hostId: record.dashboard?.hostId,
  }));
}

export function listDecisions(cwd) {
  return unfinishedTasks(cwd).flatMap(({ directory }) => {
    const decisions = join(directory, 'decisions');
    return folders(decisions, 'decision-').map(id => latestRecord(join(decisions, id)));
  }).filter(record => record && record.state !== 'acknowledged')
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.taskId.localeCompare(b.taskId) || a.decisionId.localeCompare(b.decisionId));
}

export function transitionDecision(cwd, operation, taskId, decisionId, file) {
  if (!slug.test(decisionId)) throw new Error('Use a lowercase decision ID of up to 64 characters.');
  const task = taskDirectory(taskId, cwd);
  const checkpoint = latestRecord(task);
  if (!checkpoint) throw new Error('Decision requires an assigned task.');
  const dir = join(task, 'decisions', 'decision-' + decisionId);
  const last = latestRecord(dir);
  if (operation === 'decision-request') {
    const request = requestFrom(file);
    if (!last) {
      if (checkpoint.stage === 'merged' || checkpoint.stage === 'cancelled') throw new Error('This task is closed.');
      return appendRecord(dir, 0, { taskId, decisionId, state: 'pending', requestedAt: new Date().toISOString(), request });
    }
    if (JSON.stringify(request) === JSON.stringify(last.request)) return last;
    throw new Error('This decision ID already belongs to another request. Use a new ID for a new question.');
  }
  if (!last) throw new Error('Unknown decision.');
  if (operation === 'decision-answer') {
    const answer = inputFile(file);
    if (last.state === 'pending') return appendRecord(dir, last.revision, { ...last, state: 'answered', answer });
    if (last.answer === answer) return last;
    throw new Error('This decision already has a different answer.');
  }
  if (operation !== 'decision-ack') throw new Error('Invalid decision operation.');
  if (last.state === 'acknowledged') return last;
  if (last.state !== 'answered') throw new Error('Record the answer before acknowledging delivery.');
  return appendRecord(dir, last.revision, { ...last, state: 'acknowledged' });
}
