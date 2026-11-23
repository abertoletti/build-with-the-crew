import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const bundledSkills = fileURLToPath(new URL('../role-skills/', import.meta.url));
const skillName = '[a-z][a-z0-9-]{0,63}';
const selector = new RegExp(`^(project:)?(${skillName})$`);
const baseSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const nonportable = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)|\.$/i;

export class SkillUnavailable extends Error {}

export function skillSelection(value) {
  const match = typeof value === 'string' && selector.exec(value);
  if (!match) throw new Error('Invalid skill selector: ' + value);
  return { source: match[1] ? 'project' : 'bundle', name: match[2] };
}

function inside(root, file) {
  const part = relative(root, file);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
}

function gitObjects(cwd, args) {
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitFiles(cwd, revision, directory) {
  if (!baseSha.test(revision)) throw new Error('A full trusted revision is required for project review skills.');
  const records = gitObjects(cwd, ['ls-tree', '-r', '-z', revision, '--', directory + '/']).toString().split('\0').filter(Boolean);
  return records.map(record => {
    const tab = record.indexOf('\t');
    const [mode, kind, oid] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1).slice(directory.length + 1);
    if (kind !== 'blob' || !['100644', '100755'].includes(mode) || !baseSha.test(oid) ||
        !file.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && !nonportable.test(part))) {
      throw new Error('Project skill resources on the trusted base must be regular files with portable paths.');
    }
    return { file, oid, mode };
  });
}

function validateBody(body, name) {
  const frontmatter = body.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  if (!new RegExp(`^name:[ \\t]*${name}[ \\t]*\\r?$`, 'm').test(frontmatter)) {
    throw new Error('SKILL.md must declare name: ' + name);
  }
}

export function checkRoleSkills(cwd, roleName, role, revision) {
  const available = [], problems = [];
  for (const [selectors, required] of [[role.skills, true], [role.optionalSkills ?? [], false]]) {
    for (const value of selectors) {
      const { source, name } = skillSelection(value);
      const relativeDir = '.agents/skills/' + name;
      const project = source === 'project';
      const target = project ? relativeDir : 'role-skills/' + name;
      try {
        const path = join(project ? cwd : bundledSkills, project ? relativeDir : name);
        if (project && revision) {
          const files = gitFiles(cwd, revision, relativeDir);
          const manifest = files.find(item => item.file === 'SKILL.md');
          if (!manifest) throw new Error('SKILL.md is missing from the trusted base');
          validateBody(gitObjects(cwd, ['cat-file', 'blob', manifest.oid]).toString(), name);
          available.push({ name, source, target, revision, files });
          continue;
        }
        const root = realpathSync(project ? cwd : bundledSkills);
        const directory = realpathSync(path);
        const manifest = join(directory, 'SKILL.md');
        if (!inside(root, directory) || !lstatSync(manifest, { throwIfNoEntry: false })?.isFile()) {
          throw new Error('SKILL.md must be a regular file inside the skill directory');
        }
        validateBody(readFileSync(manifest, 'utf8'), name);
        if (project) checkResources(directory);
        available.push({ name, source, target, path: directory });
      } catch (error) {
        const reason = error.code === 'ENOENT' ? 'SKILL.md is missing' : error.code === 'EACCES' || error.code === 'EPERM'
          ? 'access denied' : error.message.split(/\r?\n/, 1)[0];
        const action = project ? 'Provide this directory in the project' + (revision ? ' on the trusted base' : '') + '.'
          : 'Install the complete Build with the Crew bundle in this environment.';
        problems.push({ skill: value, required, target, reason, action });
      }
    }
  }
  const runtime = role.runtime ?? 'codex-native';
  return { role: roleName, runtime, status: problems.some(problem => problem.required) ? 'blocked' : problems.length ? 'warning' : 'ready',
    available, problems };
}

export function requireRoleSkills(cwd, roleName, role, revision) {
  const report = checkRoleSkills(cwd, roleName, role, revision);
  if (report.status === 'blocked') {
    const details = report.problems.filter(problem => problem.required)
      .map(problem => `${problem.skill} (${problem.target}): ${problem.reason}. ${problem.action}`);
    throw new SkillUnavailable(`${roleName} / ${report.runtime} in ${cwd}: ${details.join(' ')}`);
  }
  return report;
}

function checkResources(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.isDirectory()) checkResources(join(directory, item.name));
    else if (!item.isFile()) throw new SkillUnavailable('Project skill resources must be regular files: ' + item.name);
  }
}

export function stageRoleSkills(cwd, skills, root) {
  for (const skill of skills) {
    const destination = join(root, skill.name);
    if (!skill.revision) {
      if (skill.source === 'project') checkResources(skill.path);
      cpSync(skill.path, destination, { recursive: true, errorOnExist: true, force: false });
      continue;
    }
    for (const { file, oid, mode } of skill.files) {
      const path = join(destination, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, gitObjects(cwd, ['cat-file', 'blob', oid]), { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
    }
  }
}
