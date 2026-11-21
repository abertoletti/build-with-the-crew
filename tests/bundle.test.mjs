import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaults, pluginRoot, resolveConfig } from '../plugins/build-with-the-crew/scripts/project.mjs';

const distribution = fileURLToPath(new URL('../', import.meta.url));
const bundle = join(pluginRoot, 'role-skills');
const metadataFiles = new Set(['.gitattributes', 'SHA256SUMS', 'sources.lock.json']);

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function regularFiles(dir, prefix = '') {
  assert.ok(lstatSync(dir).isDirectory(), `Expected a real directory: ${dir}`);
  const paths = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink(), `Unexpected link: ${path}`);
    if (entry.isDirectory()) paths.push(...regularFiles(join(dir, entry.name), path + '/'));
    else {
      assert.ok(entry.isFile(), `Unexpected non-file: ${path}`);
      paths.push(path);
    }
  }
  return paths;
}

function manifestEntries() {
  const entries = new Map();
  for (const line of readFileSync(join(bundle, 'SHA256SUMS'), 'utf8').trimEnd().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, 'Malformed SHA256SUMS line');
    const [, hash, path] = match;
    assert.ok(!path.includes('\\') && !path.includes(':') && !path.startsWith('/') &&
      !path.startsWith('../') && posix.normalize(path) === path, `Invalid resource path: ${path}`);
    assert.ok(!entries.has(path), `Duplicate resource: ${path}`);
    entries.set(path, hash);
  }
  return entries;
}

test('the marketplace locates the installable plugin and both workflow skills', () => {
  const market = json(join(distribution, '.agents/plugins/marketplace.json'));
  const plugin = market.plugins.find(p => p.name === 'build-with-the-crew');
  assert.equal(market.name, 'crew-tools');
  assert.equal(plugin?.source.source, 'local');
  const installed = resolve(distribution, plugin.source.path);
  assert.equal(installed, resolve(pluginRoot));
  const manifest = json(join(installed, '.codex-plugin/plugin.json'));
  assert.equal(manifest.name, plugin.name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  const skills = resolve(installed, manifest.skills);
  assert.equal(skills, join(installed, 'skills'));
  for (const name of ['crew-coordinator', 'crew-task']) {
    const body = readFileSync(join(skills, name, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp('^name: ' + name + '\\r?$', 'm'));
    for (const [, ref] of body.matchAll(/\[[^\]]+\]\((references\/[^)#\s]+)(?:#[^)]*)?\)/g)) {
      assert.ok(lstatSync(join(skills, name, ref)).isFile(), `Missing workflow reference: ${ref}`);
    }
  }
  for (const file of ['scripts/method.mjs', 'scripts/specialist.mjs', 'role-skills/SHA256SUMS']) {
    assert.ok(lstatSync(join(installed, file)).isFile(), file);
  }
});

test('every third-party file and notice is covered by its digest and belongs to the distribution', () => {
  const expected = manifestEntries();
  const actual = regularFiles(bundle).filter(p => !metadataFiles.has(p));
  assert.deepEqual(actual.sort(), [...expected.keys()].sort());
  assert.equal(new Set(actual.map(p => p.toLowerCase())).size, actual.length, 'Case collision on Windows');
  for (const [path, digest] of expected) assert.equal(sha256(join(bundle, path)), digest, path);
});

test('the source lock accounts for every role, file and applicable license', () => {
  const lock = json(join(bundle, 'sources.lock.json'));
  assert.equal(lock.formatVersion, 1);
  const available = new Set();
  const accounted = new Set();
  const manifest = manifestEntries();
  for (const source of lock.sources) {
    assert.match(source.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    assert.match(source.commit, /^[0-9a-f]{40}$/);
    const notices = source.notices.map(path => {
      assert.ok(path.startsWith('_licenses/') && manifest.has(path), path);
      accounted.add(path);
      return readFileSync(join(bundle, path), 'utf8');
    });
    if (source.license === 'MIT') {
      assert.ok(notices.some(text => text.includes('Permission is hereby granted, free of charge')), source.repository);
    } else {
      assert.equal(source.license, 'Apache-2.0');
      assert.ok(notices.some(text => text.includes('Apache License') && text.includes('Version 2.0')), source.repository);
      assert.ok(source.notices.some((p, i) => p.endsWith('/NOTICE.md') && notices[i].includes('Third-Party Notices')), source.repository);
    }
    for (const skill of source.skills) {
      assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(!available.has(skill.name), `Duplicate skill: ${skill.name}`);
      available.add(skill.name);
      assert.equal(posix.basename(skill.path), skill.name);
      assert.match(skill.gitTree, /^[0-9a-f]{40}$/);
      const files = regularFiles(join(bundle, skill.name), skill.name + '/');
      assert.equal(files.length, skill.files, skill.name);
      assert.equal(manifest.get(skill.name + '/SKILL.md'), skill.skillMdSha256, skill.name);
      for (const file of files) accounted.add(file);
    }
  }
  assert.deepEqual([...accounted].sort(), [...manifest.keys()].sort());
  const roles = resolveConfig(defaults('sample/project', 'main')).roles;
  for (const [role, config] of Object.entries(roles)) {
    for (const name of config.skills) assert.ok(available.has(name), role + '/' + name);
  }
});

test('default role skills can open their referenced playbooks from the package', () => {
  const roles = resolveConfig(defaults('sample/project', 'main')).roles;
  const assigned = new Set(Object.values(roles).flatMap(role => role.skills));
  for (const name of assigned) {
    const skill = join(bundle, name);
    const body = readFileSync(join(skill, 'SKILL.md'), 'utf8');
    // Markdown links and literal playbook paths are both used in the upstream skills.
    const links = [...body.matchAll(/\[[^\]]+\]\(([^\s)#]+)(?:#[^)]+)?\)/g)]
      .map(match => match[1]).filter(target => !/^[a-z]+:/i.test(target));
    const playbooks = [...body.matchAll(/`(references?\/[\w./-]+\.md)`/g)].map(match => match[1]);
    for (const ref of new Set([...links, ...playbooks])) {
      assert.ok(lstatSync(resolve(skill, ref)).isFile(), `Missing reference: ${name}/${ref}`);
    }
  }
  for (const path of ['impeccable/scripts/impeccable.cmd', 'impeccable/scripts/engine-checksums.txt',
    'impeccable/reference/critique.md', 'code-review-excellence/references/review-techniques.md',
    'code-review-excellence/references/review-patterns.md']) {
    assert.ok(lstatSync(join(bundle, path)).isFile(), path);
  }
});
