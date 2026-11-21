import { spawnSync } from 'node:child_process';
import { authExitCode, ClaudeAuthError } from './claude-auth.mjs';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClaudeModel, readRequest, readReviewDiff, requireCurrentHead } from './specialist.mjs';

const skillRoot = fileURLToPath(new URL('../role-skills/', import.meta.url));
const claudeScript = fileURLToPath(new URL('specialist.mjs', import.meta.url));
const runtimeName = /^[a-z][a-z0-9-]{0,63}$/;

export function validateRuntimeName(value) {
  if (typeof value !== 'string' || !runtimeName.test(value)) throw new Error('Invalid specialist runtime name.');
  return value;
}

export function validModel(runtime, model) {
  if (typeof runtime !== 'string' || !runtimeName.test(runtime)) return false;
  if (runtime === 'claude-code') return isClaudeModel(model);
  return typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9./:@_-]{0,159}$/.test(model);
}

function commandFor(runtime) {
  if (runtime === 'claude-code') return { command: process.execPath, args: [claudeScript] };
  const path = process.env.CREW_ADAPTERS_FILE ?? process.env.METODO_ADAPTERS_FILE;
  if (!path || !isAbsolute(path)) throw new Error('Custom runtimes need an absolute CREW_ADAPTERS_FILE.');
  const registry = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (registry?.version !== 1 || !registry.adapters || typeof registry.adapters !== 'object' ||
      Array.isArray(registry.adapters)) throw new Error('Invalid specialist adapter registry.');
  if (!Object.hasOwn(registry.adapters, runtime)) throw new Error('Unregistered specialist runtime: ' + runtime);
  const entry = registry.adapters[runtime];
  if (!entry || typeof entry.command !== 'string' || !isAbsolute(entry.command) ||
      !Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Error('An adapter registration requires an absolute command and an array of literal arguments.');
  }
  const command = realpathSync(entry.command);
  if (!statSync(command).isFile() || (process.platform === 'win32' && /\.(bat|cmd)$/i.test(command))) {
    throw new Error('Register an executable that can run without a shell.');
  }
  return { command, args: entry.args };
}

function stageExternal(input, runtime, directory) {
  const workspace = join(directory, 'inputs');
  mkdirSync(workspace);
  const files = input.files.map((name, index) => {
    const source = realpathSync(resolve(input.cwd, name));
    const local = relative(input.cwd, source);
    if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep) || !statSync(source).isFile()) {
      throw new Error('Specialist attachment is outside its workspace or is not a file.');
    }
    const staged = String(index + 1) + '-' + basename(source);
    copyFileSync(source, join(workspace, staged));
    return staged;
  });
  const request = { ...input, runtime, adapterProtocol: 1, cwd: workspace, files, skillRoot };
  if (input.role === 'review') {
    const diff = readReviewDiff(input.cwd, input.baseSha, input.headSha);
    request.diffPath = join(directory, 'review.patch');
    request.diffSha256 = createHash('sha256').update(diff).digest('hex');
    writeFileSync(request.diffPath, diff, { flag: 'wx', mode: 0o600 });
  }
  return request;
}

function identifier(value) {
  return typeof value === 'string' && value.length <= 256 && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

// A registered adapter attests the provider-side identities. The local process can
// independently bind those claims to the requested role, inputs and Git revision.
export function receiptFor(result, input, runtime) {
  if (!result || result.role !== input.role || result.requestedModel !== input.model || result.requestedEffort !== input.effort ||
      !identifier(result.model) || !identifier(result.sessionId) || !identifier(result.agentToolUseId) ||
      JSON.stringify(result.skills) !== JSON.stringify(input.skills) ||
      typeof result.summary !== 'string' || !result.summary.trim()) {
    throw new Error('Incomplete or mismatched specialist receipt.');
  }
  const receipt = { runtime, role: input.role, requestedModel: input.model, model: result.model,
    skills: input.skills, sessionId: result.sessionId, agentToolUseId: result.agentToolUseId, summary: result.summary };
  if (input.effort) receipt.requestedEffort = input.effort;
  if (input.role === 'ux') {
    if (runtime === 'claude-code') {
      const { verifiedInputs, deliveredImages, referencesRead } = result.evidence ?? {};
      if (!Number.isSafeInteger(verifiedInputs) || !Number.isSafeInteger(deliveredImages) ||
          deliveredImages < 1 || deliveredImages > verifiedInputs ||
          !Array.isArray(referencesRead) || !referencesRead.every(reference => typeof reference === 'string' &&
            reference.length > 0 && input.skills.includes(reference.split('/')[0]))) {
        throw new Error('Incomplete verified UX evidence from the bundled Claude adapter.');
      }
      receipt.evidence = { verifiedInputs, deliveredImages, referencesRead };
    }
    return receipt;
  }
  if (result.baseSha !== input.baseSha || result.headSha !== input.headSha ||
      !['approved', 'changes_requested'].includes(result.verdict) ||
      typeof result.diffSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(result.diffSha256) ||
      (input.diffSha256 !== undefined && result.diffSha256 !== input.diffSha256)) {
    throw new Error('Specialist receipt does not match this review and diff.');
  }
  return { ...receipt, baseSha: input.baseSha, headSha: input.headSha, diffSha256: result.diffSha256, verdict: result.verdict };
}

export function invokeSpecialist(request, runtime = 'claude-code') {
  validateRuntimeName(runtime);
  const registration = commandFor(runtime);
  const input = readRequest(request, model => validModel(runtime, model), runtime);
  for (const skill of input.skills) {
    if (!lstatSync(join(skillRoot, skill, 'SKILL.md'), { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Missing packaged skill: ' + skill);
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'crew-runtime-'));
  try {
    const payload = runtime === 'claude-code' ? input : stageExternal(input, runtime, directory);
    const requestFile = join(directory, 'request.json');
    writeFileSync(requestFile, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
    const child = spawnSync(registration.command, [...registration.args, requestFile], {
      cwd: directory, shell: false, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024, timeout: 16 * 60 * 1000,
    });
    if (child.error || child.status !== 0) {
      if (runtime === 'claude-code' && child.status === authExitCode) throw new ClaudeAuthError();
      const status = child.error?.code ?? child.status ?? child.signal;
      // Only the bundled adapter redacts its errors. Third-party stderr can contain credentials or prompts.
      const detail = runtime === 'claude-code' ? (child.stderr ?? '').trim().slice(0, 600) : '';
      throw new Error(runtime + ' adapter failed (' + status + ').' + (detail ? ' ' + detail : ''));
    }
    let result;
    try { result = JSON.parse(child.stdout); } catch { throw new Error('Expected one JSON receipt from the specialist adapter.'); }
    const receipt = receiptFor(result, payload, runtime);
    if (input.role === 'review' && runtime !== 'claude-code') requireCurrentHead(input.cwd, input.headSha);
    return receipt;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
