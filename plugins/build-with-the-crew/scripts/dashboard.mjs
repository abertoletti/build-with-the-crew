import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { history, loadConfig, rootDir, storageDir } from './project.mjs';
import { agentStates } from './agent-events.mjs';

const host = '127.0.0.1';
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/dashboard.css', ['dashboard.css', 'text/css']],
  ['/dashboard.js', ['dashboard.js', 'application/javascript']],
]);
const taskStates = new Set(['assigned', 'working', 'waiting-human', 'review', 'testing', 'ready', 'merged', 'cancelled']);
const reviewStates = new Set(['reviewing', 'awaiting-auth', 'failed', 'approved', 'changes_requested', 'interrupted', 'integrating', 'merged']);
const ownerRepo = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/i;

function folders(dir, pattern) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && pattern.test(entry.name)).map(entry => entry.name);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}

function label(value, limit = 140) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : null;
}

function makeEvent(record, type, detail) {
  return { type, state: type === 'task' ? record.stage : record.state,
    at: label(record.recordedAt, 40), revision: record.revision, ...detail };
}

function projectSnapshot(project) {
  const { journal } = project;
  const tasks = [], pullRequests = [];
  let unavailable = 0;

  function records(dir) {
    try { return history(dir, 24); }
    catch { unavailable++; return []; }
  }

  for (const directory of folders(join(journal, 'tasks'), /^task-[a-z0-9][a-z0-9-]{0,63}$/)) {
    const taskDir = join(journal, 'tasks', directory);
    const log = records(taskDir).filter(record => taskStates.has(record?.stage));
    if (!log.length) continue;
    const id = directory.slice(5);
    const last = log.at(-1);
    const meta = last.dashboard ?? {};
    const agents = [];
    const events = log.map(record => makeEvent(record, 'task', {}));
    const agentsDir = join(taskDir, 'agents');
    for (const name of folders(agentsDir, /^agent-[a-z0-9][a-z0-9-]{0,63}$/)) {
      const activity = records(join(agentsDir, name)).filter(record => agentStates.has(record?.state));
      if (!activity.length) continue;
      const current = activity.at(-1);
      const id = name.slice(6);
      const agent = { id, label: label(current.label), state: current.state, at: label(current.recordedAt, 40), revision: current.revision };
      agents.push(agent);
      events.push(...activity.map(record => makeEvent(record, 'agent', { agentId: id, label: agent.label })));
    }
    tasks.push({ id, title: label(meta.title), stage: last.stage, at: label(last.recordedAt, 40),
      branch: label(meta.branch), worktree: label(meta.worktree, 512), threadId: label(meta.threadId),
      prNumber: Number.isSafeInteger(meta.prNumber) && meta.prNumber > 0 ? meta.prNumber : null,
      agents, events });
  }

  const reviews = join(journal, 'reviews');
  for (const owner of folders(reviews, /^r-[a-z0-9][a-z0-9-]*$/i)) {
    for (const repo of folders(join(reviews, owner), /^r-[a-z0-9_.-]+$/i)) {
      for (const pull of folders(join(reviews, owner, repo), /^pr-[1-9]\d*$/)) {
        const log = records(join(reviews, owner, repo, pull)).filter(record => reviewStates.has(record?.state));
        if (!log.length) continue;
        const repository = owner.slice(2) + '/' + repo.slice(2);
        if (!ownerRepo.test(repository)) continue;
        const number = Number(pull.slice(3));
        const last = log.at(-1);
        const attempt = log.findLast(record => record.state === 'reviewing' && record.headSha === last.headSha && record.round === last.round);
        pullRequests.push({ repository, number, state: last.state, round: last.round, at: label(last.recordedAt, 40),
          model: label(last.receipt?.model ?? attempt?.reviewer?.model),
          runtime: label(last.receipt?.runtime ?? attempt?.reviewer?.runtime),
          events: log.map(record => makeEvent(record, 'review', { round: record.round })) });
      }
    }
  }

  return { id: project.id, name: project.name, repository: project.repository, tasks, pullRequests, unavailable };
}

export function dashboardProjects(paths) {
  const projects = new Map();
  for (const path of paths) {
    const root = rootDir(path);
    const journal = storageDir(root);
    if (projects.has(journal)) continue;
    let repository = null;
    try { repository = loadConfig(root).repository; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    projects.set(journal, { id: projects.size + 1, name: repository ?? basename(root), repository, journal });
  }
  return [...projects.values()];
}

export function createDashboard(projects, token = randomBytes(24).toString('hex')) {
  const assets = new Map([...files].map(([route, [name, mime]]) => [route,
    { mime, body: readFileSync(new URL('../dashboard/' + name, import.meta.url)) }]));
  const server = createServer((req, res) => {
    const address = server.address();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.headers.host !== host + ':' + address.port || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
      return res.writeHead(403).end();
    }
    if (req.method !== 'GET') return res.writeHead(405, { Allow: 'GET' }).end();
    if (req.url === '/api/snapshot') {
      const actual = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + token);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.writeHead(401).end();
      const items = projects.map(project => {
        try { return projectSnapshot(project); }
        catch { return { id: project.id, name: project.name, tasks: [], pullRequests: [], unavailable: 1 }; }
      });
      return res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ projects: items }));
    }
    const asset = assets.get(req.url);
    if (!asset) return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': asset.mime + '; charset=utf-8' }).end(asset.body);
  });
  return { server, token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node dashboard.mjs [REPOSITORY ...]\nOpen a local read-only dashboard for the given repositories. Defaults to the current repository.');
  } else {
    try {
      const projects = dashboardProjects(args.length ? args : [process.cwd()]);
      const { server, token } = createDashboard(projects);
      server.on('error', error => { console.error(error.message); process.exitCode = 1; });
      server.listen(0, host, () => {
        console.log(`Crew dashboard: http://${host}:${server.address().port}/#${token}`);
        console.log(`Watching ${projects.length} ${projects.length === 1 ? 'repository' : 'repositories'}. Press Ctrl+C to stop.`);
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
