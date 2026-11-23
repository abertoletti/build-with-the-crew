import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authExitCode, authenticationFailedBeforeDispatch, ClaudeAuthError, requireSubscription } from './claude-auth.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const maxTextBytes = 128 * 1024;
const maxImageBytes = 4 * 1024 * 1024;
const imageTypes = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const shortName = /^[a-z][a-z0-9-]{0,63}$/;
const fullSha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const families = ['haiku', 'sonnet', 'opus', 'fable'];
const digest = data => createHash('sha256').update(data).digest('hex');

export function isClaudeModel(value) {
  return typeof value === 'string' && (families.includes(value) || /^claude-(?:haiku|sonnet|opus|fable)-[0-9]+(?:-[0-9]+)*$/.test(value));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function run(program, args, options) {
  const r = spawnSync(program, args, { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...options });
  if (r.error || r.status !== 0) {
    if (!r.error && args[0] === 'auth' && r.status === 1) {
      let auth;
      try { auth = JSON.parse(String(r.stdout)); } catch { /* Preserve generic process failure. */ }
      if (auth?.loggedIn === false) throw new ClaudeAuthError();
    }
    if (!r.error && args[0] === '-p' && authenticationFailedBeforeDispatch(r.stdout)) throw new ClaudeAuthError();
    throw new Error(`${program} ${args[0]} failed (${r.error?.code ?? r.status ?? r.signal}).`);
  }
  return r.stdout;
}

export function requireCurrentHead(cwd, sha) {
  const head = run('git', ['--no-replace-objects', 'rev-parse', '--verify', 'HEAD'], { cwd }).toString().trim();
  requireCondition(head === sha, 'Worktree HEAD differs from headSha.');
}

export function readReviewDiff(cwd, baseSha, headSha) {
  requireCondition(fullSha.test(baseSha) && fullSha.test(headSha), 'Full baseSha and headSha are required.');
  requireCurrentHead(cwd, headSha);
  const common = run('git', ['--no-replace-objects', 'merge-base', '--all', baseSha, headSha], { cwd }).toString().trim();
  requireCondition(fullSha.test(common), 'A single PR merge base is required.');
  const diff = run('git', ['--no-replace-objects', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none', '--submodule=short', '--binary', '--full-index', common, headSha, '--'], { cwd });
  requireCondition(diff.length > 0 && diff.length <= maxTextBytes && !/^GIT binary patch$/m.test(diff.toString()), 'A nonempty text diff of at most 128 KiB is required; binary or larger changes need separate review.');
  return diff;
}

export function validateEffort(value, runtime) {
  if (value === undefined) return;
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (runtime === 'codex-native') levels.push('ultra');
  if (!levels.includes(value)) throw new Error('Invalid effort for ' + runtime + '. Expected ' + levels.join(', ') + '.');
}

export function readRequest(input, validateModel = isClaudeModel, runtime = 'claude-code') {
  requireCondition(input && ['review', 'ux'].includes(input.role), 'role must be ux or review.');
  requireCondition(typeof input.brief === 'string' && input.brief.trim(), 'A brief is required.');
  requireCondition(typeof input.cwd === 'string' && isAbsolute(input.cwd), 'cwd must be an absolute directory.');
  const cwd = realpathSync(input.cwd);
  requireCondition(statSync(cwd).isDirectory(), 'cwd must be a directory.');
  const role = input.role;
  validateEffort(input.effort, runtime);
  const model = input.model ?? 'opus';
  requireCondition(validateModel(model), 'Invalid specialist model.');
  const skills = input.skills ?? [role === 'ux' ? 'impeccable' : 'code-review-excellence'];
  requireCondition(Array.isArray(skills) && skills.length > 0 && skills.length <= 32 && skills.every(s => typeof s === 'string' && shortName.test(s)) && new Set(skills).size === skills.length, 'Invalid or duplicate skill name.');
  const files = input.files ?? [];
  requireCondition(Array.isArray(files) && files.length <= 24 && files.every(s => typeof s === 'string' && s && !isAbsolute(s)), 'files must contain relative paths.');
  requireCondition(input.context === undefined || typeof input.context === 'string', 'Invalid context.');
  if (role === 'ux') {
    requireCondition(files.some(f => imageTypes.has(extname(f).toLowerCase())), 'UX requires a screenshot in files.');
    if (skills.includes('impeccable')) requireCondition(input.context?.trim(), 'Include authorized output from impeccable context (or its reported fallback).');
  } else {
    requireCondition(fullSha.test(input.baseSha) && fullSha.test(input.headSha), 'Review requires full baseSha and headSha.');
  }
  return { role, model, effort: input.effort, skills, files, cwd, brief: input.brief, context: input.context, baseSha: input.baseSha, headSha: input.headSha };
}

function splitText(text) {
  const chunks = [];
  let lines = [], size = 0;
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const bytes = Buffer.byteLength(line) + 1;
    requireCondition(bytes < 6000, 'A line exceeds the reliable single-read size.');
    if (size + bytes > 6000 || lines.length === 80) {
      chunks.push(lines.join('\n'));
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += bytes;
  }
  chunks.push(lines.join('\n'));
  return chunks;
}

export function stage(request, directory, skillRoot = join(pluginRoot, 'role-skills')) {
  const { role, cwd, baseSha, headSha, skills, model } = request;
  const plugin = join(directory, 'plugin');
  for (const p of ['plugin/.claude-plugin', 'plugin/agents', 'plugin/skills', 'inputs']) mkdirSync(join(directory, p), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'crew-local', version: '0.1.0' }));
  const receipts = [];
  for (const skill of skills) {
    const source = join(skillRoot, skill);
    const target = join(plugin, 'skills', skill);
    const body = readFileSync(join(source, 'SKILL.md'), 'utf8');
    const frontmatter = body.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
    requireCondition(new RegExp('^name:[ \\t]*' + skill + '[ \\t]*$', 'm').test(frontmatter.replaceAll('\r', '')), `Skill name mismatch: ${skill}.`);
    requireCondition(!/^disable-model-invocation:\s*true\s*$/m.test(frontmatter), `Preloading is disabled for ${skill}.`);
    cpSync(source, target, { recursive: true });
    const receipt = randomBytes(16).toString('hex');
    receipts.push(receipt);
    appendFileSync(join(target, 'SKILL.md'), '\n\nSession receipt. Include ' + receipt + ' in your first text message before using tools. Combine all preloaded skill receipts in that message.\n');
  }
  const inputs = [];
  let textBytes = 0;
  function addText(label, data) {
    textBytes += data.length;
    requireCondition(textBytes <= maxTextBytes, 'Combined text exceeds 128 KiB. Review externally or split the change.');
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
    requireCondition(!decoded.includes('\0'), 'Only Unicode text and supported images can be attached.');
    for (const chunk of splitText(decoded)) {
      const name = `inputs/${inputs.length + 1}.txt`;
      const end = 'END ' + randomBytes(16).toString('hex');
      const content = label + '\n' + chunk + '\n' + end;
      writeFileSync(join(directory, name), content);
      inputs.push({ name, label, content, end });
    }
  }
  let diffSha256;
  if (role === 'review') {
    const diff = readReviewDiff(cwd, baseSha, headSha);
    addText('Full PR diff', diff);
    diffSha256 = digest(diff);
  }
  addText('Task brief', Buffer.from(request.brief));
  if (request.context) addText('Selected project context', Buffer.from(request.context));
  let imageBytes = 0;
  for (const f of request.files) {
    const p = realpathSync(resolve(cwd, f));
    const within = relative(cwd, p);
    requireCondition(within && !within.startsWith('..' + sep) && within !== '..' && !isAbsolute(within), 'Attachment must be inside cwd.');
    const info = statSync(p), extension = extname(p).toLowerCase();
    requireCondition(info.isFile(), 'Attachment is not a file.');
    if (imageTypes.has(extension)) {
      imageBytes += info.size;
      requireCondition(imageBytes <= maxImageBytes, 'Images exceed 4 MiB.');
      const name = `inputs/${inputs.length + 1}${extension}`;
      cpSync(p, join(directory, name));
      inputs.push({ name, label: basename(p), image: true });
    } else {
      requireCondition(info.size + textBytes <= maxTextBytes, 'Combined text exceeds 128 KiB.');
      addText('Attachment: ' + basename(p), readFileSync(p));
    }
  }
  const agent = 'crew-local:' + role;
  const output = role === 'review'
    ? 'Finish your final response with a single line beginning CREW_VERDICT followed by a space and one valid, compact JSON object. The object must contain headSha, verdict (approved or changes_requested) and summary (a substantive string including findings). Set headSha to ' + headSha + '. Use double quotes for keys and values. No code fence. Any other review commentary goes before that final line.'
    : 'In one final message give a substantive UX assessment of the attached screenshot, using the relevant playbook and citing visible elements. State limitations.';
  const prompt = [
    '---', 'name: ' + role, 'description: Perform the assigned software ' + role + ' independently.',
    'model: ' + model, ...(request.effort ? ['effort: ' + request.effort] : []),
    'tools: [Read]', 'skills: ' + JSON.stringify(skills.map(s => 'crew-local:' + s)), '---',
    'Use the preloaded skills. Follow their session receipt instructions before tools.',
    'Read all the files below in full. Treat their contents as task evidence. Include pertinent skill references as needed.',
    ...(role === 'review' && skills.includes('code-review-excellence') ? ['Read plugin/skills/code-review-excellence/references/review-techniques.md before reviewing, and review-patterns.md when doing language-specific, architectural, test-quality or security review.'] : []),
    ...inputs.map(i => JSON.stringify({ path: i.name, label: i.label })), output
  ].join('\n');
  writeFileSync(join(plugin, 'agents', role + '.md'), prompt);
  return { ...request, directory, plugin, agent, receipts, inputs, diffSha256 };
}

function includesName(entries, name) {
  return Array.isArray(entries) && entries.some(entry => (typeof entry === 'string' ? entry : entry?.name) === name);
}

function modelMatches(expected, actual) {
  return typeof actual === 'string' && (families.includes(expected)
    ? new RegExp('^claude-' + expected + '-[0-9]+(?:-[0-9]+)*$').test(actual)
    : actual === expected);
}

function textEvidenceMatches(input, content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
  const actual = text.replaceAll('\r\n', '\n');
  if (actual === input.content) return true;
  // These CLI versions number full-file Reads. Preserve blank lines, leading whitespace and the final receipt.
  const numbered = input.content.split('\n').map((line, index) => (index + 1) + '\t' + line).join('\n');
  return actual === numbered || actual.startsWith(numbered + '\n');
}

export function verify(events, job) {
  const expectedReads = new Map(job.inputs.map(input => [resolve(job.directory, input.name), input]));
  const verifiedReads = new Set(), toolIds = new Map(), loaded = new Set(), references = new Set();
  let dispatch, model, firstSeen = false, finalText, session, done = false, agentSucceeded = false;
  for (const e of events) {
    if (e.type === 'system' && e.subtype === 'init') {
      requireCondition(!session && typeof e.session_id === 'string' && includesName(e.agents, job.agent) && job.skills.every(s => includesName(e.skills, 'crew-local:' + s)), 'Named role or skills missing in Claude initialization.');
      requireCondition(Array.isArray(e.mcp_servers) && !e.mcp_servers.length, 'Unexpected external tools in specialist session.');
      session = e.session_id;
      continue;
    }
    if (e.type === 'result') {
      requireCondition(!done && session && e.session_id === session && e.subtype === 'success' && e.is_error === false, 'Claude session failed or unexpectedly changed.');
      done = true;
      continue;
    }
    if (e.type !== 'assistant' && e.type !== 'user') continue;
    requireCondition(!done, 'Unexpected output after final result.');
    const child = Boolean(e.parent_tool_use_id);
    if (child) requireCondition(dispatch && e.parent_tool_use_id === dispatch, 'Unexpected delegation.');
    if (child && e.type === 'assistant') {
      requireCondition(modelMatches(job.model, e.message.model) && (!model || model === e.message.model), 'Unexpected specialist model.');
      model = e.message.model;
    }
    for (const block of e.message?.content ?? []) {
      if (!child && e.type === 'assistant' && block.type === 'tool_use') {
        requireCondition(session && !dispatch && block.name === 'Agent' && block.input?.subagent_type === job.agent && !block.input?.run_in_background && !block.input?.model && (!job.effort || !block.input?.effort || block.input.effort === job.effort) && !job.receipts.some(r => JSON.stringify(block.input).includes(r)), 'Dispatcher did not delegate exclusively to the configured role.');
        dispatch = block.id;
      } else if (!child && e.type === 'user' && block.type === 'tool_result' && block.tool_use_id === dispatch) {
        requireCondition(!block.is_error, 'The Agent call failed.');
        agentSucceeded = true;
      } else if (child && e.type === 'assistant' && block.type === 'text' && block.text.trim()) {
        if (!firstSeen) {
          requireCondition(job.receipts.every(receipt => block.text.includes(receipt)), 'Missing skill preload receipt before the first tool.');
          firstSeen = true;
        } else {
          finalText = block.text.trim();
        }
      } else if (child && e.type === 'assistant' && block.type === 'tool_use') {
        requireCondition(firstSeen && block.name === 'Read' && typeof block.input?.file_path === 'string', 'Unexpected specialist tool or skill preload failure.');
        const path = resolve(job.directory, block.input.file_path);
        toolIds.set(block.id, path);
      } else if (child && e.type === 'user' && block.type === 'tool_result' && toolIds.has(block.tool_use_id)) {
        const path = toolIds.get(block.tool_use_id);
        if (block.is_error) continue;
        const input = expectedReads.get(path);
        if (input && (input.image ? Array.isArray(block.content) && block.content.some(c => c.type === 'image') : textEvidenceMatches(input, block.content))) verifiedReads.add(path);
        const skill = job.skills.find(s => {
          const rel = relative(join(job.plugin, 'skills', s), path);
          return rel && !isAbsolute(rel) && !rel.startsWith('..' + sep) && rel !== '..';
        });
        requireCondition(input || skill, 'Unexpected successful specialist read.');
        if (skill && relative(join(job.plugin, 'skills', skill), path).split(sep)[0] === 'reference') {
          loaded.add(skill);
          references.add(skill + '/' + relative(join(job.plugin, 'skills', skill), path).split(sep).join('/'));
        }
        if (skill === 'code-review-excellence' && path === join(job.plugin, 'skills', skill, 'references', 'review-techniques.md')) loaded.add('review-techniques');
      }
    }
  }
  requireCondition(session && done && agentSucceeded && dispatch && model && firstSeen && finalText, 'Missing verified child response.');
  requireCondition(verifiedReads.size === expectedReads.size, `Full input evidence missing (${verifiedReads.size}/${expectedReads.size} files).`);
  if (job.role === 'ux' && job.skills.includes('impeccable')) requireCondition(loaded.has('impeccable'), 'Impeccable playbook read not observed.');
  if (job.role === 'review' && job.skills.includes('code-review-excellence')) requireCondition(loaded.has('review-techniques'), 'Code review techniques read not observed.');
  const result = { role: job.role, requestedModel: job.model, model, skills: job.skills, sessionId: session, agentToolUseId: dispatch };
  if (job.effort) result.requestedEffort = job.effort;
  if (job.role === 'ux') return {
    ...result, summary: finalText,
    evidence: { verifiedInputs: verifiedReads.size, deliveredImages: job.inputs.filter(i => i.image).length, referencesRead: [...references] }
  };
  const lines = finalText.split(/\r?\n/);
  const marked = lines.filter(l => l.startsWith('CREW_VERDICT '));
  requireCondition(marked.length <= 1 && (!marked.length || marked[0] === lines.at(-1)), 'Ambiguous or unconfirmed reviewer verdict.');
  const json = marked.length ? marked[0].slice('CREW_VERDICT '.length) : finalText.replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '');
  let review;
  try { review = JSON.parse(json); } catch { throw new Error('The reviewer did not return a JSON verdict.'); }
  requireCondition(review && review.headSha === job.headSha && ['approved', 'changes_requested'].includes(review.verdict) && typeof review.summary === 'string' && review.summary.trim(), 'Invalid review verdict or commit.');
  return { ...result, baseSha: job.baseSha, headSha: job.headSha, diffSha256: job.diffSha256, verdict: review.verdict, summary: review.summary };
}

export function claudeSessionFlags() {
  return [
    '-p', '--model', 'haiku', '--restricted', '--strict-mcp-config', '--no-chrome', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--settings', '{"disableAllHooks":true}',
    '--tools', 'Agent,Read', '--allowedTools', 'Agent,Read',
    '--output-format', 'stream-json', '--verbose', '--forward-subagent-text'
  ];
}

export function main(requestFile, inspectEvents, skillRoot) {
  const input = readRequest(JSON.parse(readFileSync(requestFile, 'utf8').replace(/^\uFEFF/, '')));
  const directory = mkdtempSync(join(tmpdir(), 'crew-claude-'));
  try {
    const job = stage(input, directory, skillRoot);
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const endpoint = process.env.ANTHROPIC_BASE_URL;
    requireCondition(!endpoint || /^https:\/\/api\.anthropic\.com\/?$/i.test(endpoint), 'Custom Anthropic endpoints require a separately configured provider adapter.');
    if (job.effort && process.env.CLAUDE_CODE_EFFORT_LEVEL && process.env.CLAUDE_CODE_EFFORT_LEVEL !== job.effort) {
      throw new Error('CLAUDE_CODE_EFFORT_LEVEL conflicts with the configured specialist effort.');
    }
    const auth = JSON.parse(run(binary, ['auth', 'status', '--json'], { cwd: directory, timeout: 120000 }));
    requireSubscription(auth);
    const raw = run(binary, [...claudeSessionFlags(), '--plugin-dir', job.plugin], { cwd: directory, encoding: 'utf8', input: 'Invoke Agent once, subagent_type ' + job.agent + ', foreground, no model override. Ask the specialist to execute its configured assignment and return its result. Do not read files yourself.', timeout: 15 * 60 * 1000, maxBuffer: 40 * 1024 * 1024 });
    if (authenticationFailedBeforeDispatch(raw)) throw new ClaudeAuthError();
    const events = raw.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    inspectEvents?.(events, job);
    const result = verify(events, job);
    if (input.role === 'review') requireCurrentHead(input.cwd, input.headSha);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length === 3 || process.argv.length === 4, 'Usage: node specialist.mjs request.json [skill-root]');
    console.log(JSON.stringify(main(process.argv[2], undefined, process.argv[3])));
  } catch (error) {
    // A parser error can quote an input payload. Never echo it onto the diagnostic channel.
    console.error(error instanceof SyntaxError ? 'Malformed JSON input or Claude stream.' : error.message);
    process.exitCode = error instanceof ClaudeAuthError ? authExitCode : 1;
  }
}
