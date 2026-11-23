import { join } from 'node:path';
import { appendRecord, latestRecord, taskDirectory } from './project.mjs';

export const agentStates = new Set(['agent-running', 'agent-done', 'agent-failed']);

export function recordAgentEvent(cwd, taskId, agentId, state, label) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId) || !agentStates.has(state) ||
      !label.trim() || label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) {
    throw new Error('Invalid agent activity. Provide an ID, a supported state and a short label.');
  }
  const task = taskDirectory(taskId, cwd);
  const checkpoint = latestRecord(task);
  if (!checkpoint || ['merged', 'cancelled'].includes(checkpoint.stage)) throw new Error('Agent activity requires an open task.');
  const dir = join(task, 'agents', 'agent-' + agentId);
  const last = latestRecord(dir);
  if (last?.state === state && last.label === label) return last;
  if (last ? last.state !== 'agent-running' || state === 'agent-running' || last.label !== label : state !== 'agent-running') {
    throw new Error('Record the start once and report its outcome under the same agent ID and label.');
  }
  return appendRecord(dir, last?.revision ?? 0, { state, label });
}
