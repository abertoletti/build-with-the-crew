import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEffort } from './specialist.mjs';
import { validModel, validateRuntimeName } from './runtime.mjs';

export const configurationPath = '.build-with-the-crew/config.json';
export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const roleDefaults = {
  analyst: ['user-stories'],
  architect: ['architecture-designer'],
  developer: ['test-driven-development', 'systematic-debugging'],
  qa: ['test-scenarios', 'verification-before-completion'],
  ux: ['impeccable'],
  review: ['code-review-excellence'],
};

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trimEnd();
}

export function rootDir(cwd = process.cwd()) {
  return git(['rev-parse', '--show-toplevel'], cwd);
}

export function storageDir(cwd = process.cwd()) {
  return join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd), 'metodo');
}

export function requireRepo(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(value) || /\/(?:\.|\.\.)$/.test(value)) {
    throw new Error('Expected a GitHub OWNER/REPO.');
  }
  return value;
}

function object(value, description, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + description);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error('Unknown ' + description + ' field: ' + key);
  }
  return value;
}

function label(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

export function defaults(repository, baseBranch) {
  return {
    version: 1, repository: requireRepo(repository), baseBranch,
    integration: 'ready', requiredChecks: [], testCommands: [], maxReviewRounds: 3, roles: {},
  };
}

export function resolveConfig(raw) {
  object(raw, 'configuration', ['version', 'repository', 'baseBranch', 'integration', 'mergeMethod', 'requiredChecks', 'testCommands', 'maxReviewRounds', 'roles']);
  if (raw.version !== 1) throw new Error('Unsupported project configuration version.');
  const config = { ...defaults(raw.repository, raw.baseBranch), ...raw };
  if (!label(config.baseBranch) || config.baseBranch.startsWith('-')) throw new Error('Invalid baseBranch.');
  git(['check-ref-format', 'refs/heads/' + config.baseBranch]);
  if (!['ready', 'merge'].includes(config.integration)) throw new Error('integration must be ready or merge.');
  if (config.mergeMethod !== undefined && !['merge', 'squash', 'rebase'].includes(config.mergeMethod)) throw new Error('Unknown mergeMethod.');
  if (!Array.isArray(config.testCommands) || !config.testCommands.every(label)) throw new Error('testCommands must be an array of single-line commands.');
  if (!Number.isSafeInteger(config.maxReviewRounds) || config.maxReviewRounds < 1) throw new Error('Invalid maxReviewRounds.');
  if (!Array.isArray(config.requiredChecks)) throw new Error('requiredChecks must be an array.');
  const seen = new Set();
  for (const check of config.requiredChecks) {
    object(check, 'check', ['type', 'name', 'appId']);
    if (!['status', 'check'].includes(check.type) || !label(check.name)) throw new Error('Invalid required check.');
    if (check.appId !== undefined && (check.type !== 'check' || !Number.isSafeInteger(check.appId) || check.appId < 1)) {
      throw new Error('appId must identify the GitHub App that produces a check run.');
    }
    const id = JSON.stringify([check.type, check.name.toLowerCase(), check.appId ?? null]);
    if (seen.has(id)) throw new Error('Duplicate required check: ' + check.name);
    seen.add(id);
  }
  if (config.integration === 'merge' && !config.requiredChecks.length) throw new Error('Configure at least one required check before automatic merge.');
  object(config.roles, 'roles', [...Object.keys(roleDefaults), 'coordinator', 'task']);
  const roles = {};
  for (const name of ['coordinator', 'task']) {
    if (!Object.hasOwn(config.roles, name)) continue;
    const settings = config.roles[name];
    object(settings, name, ['effort']);
    validateEffort(settings.effort, 'codex-native');
    roles[name] = { ...settings };
  }
  for (const [name, skills] of Object.entries(roleDefaults)) {
    const external = name === 'ux' || name === 'review';
    const custom = Object.hasOwn(config.roles, name) ? config.roles[name] : {};
    object(custom, name, external ? ['skills', 'model', 'runtime', 'effort'] : ['skills', 'effort']);
    const selected = custom.skills ?? skills;
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) throw new Error('Invalid skills for ' + name);
    for (const skill of selected) {
      if (typeof skill !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(skill) ||
          !existsSync(join(pluginRoot, 'role-skills', skill, 'SKILL.md'))) throw new Error('Unknown packaged skill: ' + skill);
    }
    roles[name] = { skills: selected };
    if (custom.effort !== undefined) {
      validateEffort(custom.effort, external ? custom.runtime ?? 'claude-code' : 'codex-native');
      roles[name].effort = custom.effort;
    }
    if (external) {
      const runtime = custom.runtime ?? 'claude-code';
      validateRuntimeName(runtime);
      const model = custom.model ?? (runtime === 'claude-code' ? 'opus' : undefined);
      if (!validModel(runtime, model)) throw new Error('Invalid model for runtime ' + runtime);
      Object.assign(roles[name], { runtime, model });
    }
  }
  return { ...config, roles };
}

export function initProject(repository, branch, cwd) {
  const path = join(rootDir(cwd), configurationPath);
  const config = defaults(repository, branch);
  resolveConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Configuration already exists at ' + path);
  }
  return path;
}

export function loadConfig(cwd, revision) {
  const raw = revision ? git(['show', revision + ':' + configurationPath], cwd)
    : readFileSync(join(rootDir(cwd), configurationPath), 'utf8');
  return resolveConfig(JSON.parse(raw.replace(/^\uFEFF/, '')));
}

export function taskDirectory(id, cwd) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Use a lowercase task ID of up to 64 characters.');
  // A prefix also makes Windows reserved device names safe.
  return join(storageDir(cwd), 'tasks', 'task-' + id);
}

function revisions(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter(n => /^\d{10}$/.test(n)).sort();
}

function readRevision(dir, name) {
  return JSON.parse(readFileSync(join(dir, name, 'record.json'), 'utf8'));
}

export function history(dir) {
  return revisions(dir).map(name => readRevision(dir, name));
}

export function latestRecord(dir) {
  const name = revisions(dir).at(-1);
  return name ? readRevision(dir, name) : null;
}

export function appendRecord(dir, expectedRevision, fields) {
  const current = latestRecord(dir)?.revision ?? 0;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current || current >= 9999999999) {
    throw new Error('Revision conflict. Read the current state before retrying.');
  }
  const record = { ...fields, revision: current + 1, recordedAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  const staging = mkdtempSync(join(dir, '.writing-'));
  const target = join(dir, String(record.revision).padStart(10, '0'));
  try {
    // Same-volume rename cannot replace a nonempty directory. Only the winning writer
    // publishes a revision. Interrupted staging directories are never read as records.
    writeFileSync(join(staging, 'record.json'), JSON.stringify(record) + '\n', { mode: 0o600, flush: true });
    renameSync(staging, target);
  } catch (error) {
    if (existsSync(target)) throw new Error('Concurrent update. Read the current state before retrying.');
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return record;
}

const stages = ['assigned', 'working', 'waiting-human', 'review', 'testing', 'ready', 'merged', 'cancelled'];

export function checkpoint(cwd, id, expected, stage, notePath) {
  const dir = taskDirectory(id, cwd);
  if (!stages.includes(stage) || (expected === 0) !== (stage === 'assigned')) throw new Error('Invalid task stage for this revision.');
  const note = readFileSync(resolve(notePath), 'utf8').trim();
  if (!note || Buffer.byteLength(note) > 65536) throw new Error('Expected a task note of 1 to 65536 bytes.');
  const last = latestRecord(dir);
  if (last && ['merged', 'cancelled'].includes(last.stage)) throw new Error('This task is closed.');
  return appendRecord(dir, expected, { id, stage, note });
}
