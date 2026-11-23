const states = {
  assigned: 'Assigned', working: 'Working', 'waiting-human': 'Waiting for you', review: 'In review',
  testing: 'Testing', ready: 'Ready', merged: 'Merged', cancelled: 'Cancelled',
  reviewing: 'Review requested', 'awaiting-auth': 'Waiting for sign-in', failed: 'Review failed',
  approved: 'Review approved', changes_requested: 'Changes requested', interrupted: 'Review interrupted', integrating: 'Merging',
  'agent-running': 'Running', 'agent-done': 'Finished', 'agent-failed': 'Failed',
};
const closed = new Set(['ready', 'merged', 'cancelled']);
const waiting = new Set(['waiting-human', 'awaiting-auth', 'changes_requested']);
const done = new Set(['ready', 'merged', 'approved', 'agent-done']);
const errors = new Set(['failed', 'interrupted', 'agent-failed']);
const icons = {
  coordinator: 'M12 6v5m0 0-6 6m6-6 6 6M12 2v4M4 16l2 2m14-2-2 2',
  session: 'M8 5 3 12l5 7m8-14 5 7-5 7m-3-15-2 16',
  review: 'M7 3h8l4 4v14H5V3h2m8 0v5h4M8 14l2 2 5-5',
  agent: 'M5 5h14v14H5ZM9 9h6v6H9ZM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3',
};
const token = location.hash.slice(1);
const picker = document.querySelector('#project');
const motion = document.querySelector('#motion');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const time = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
let payload = { projects: [] };
let snapshot = '';
let selected = null;
let previous = new Map();
let paused = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function text(id, value) { document.getElementById(id).textContent = value; }

function when(at) {
  const value = Date.parse(at);
  return Number.isFinite(value) ? time.format(value) : 'Time unavailable';
}

function connect(state, message) {
  const badge = document.getElementById('connection');
  if (badge.dataset.state === state) return;
  badge.dataset.state = state;
  badge.textContent = message;
}

function tone(state) {
  if (waiting.has(state)) return 'waiting';
  if (done.has(state)) return 'done';
  if (errors.has(state)) return 'error';
  return 'normal';
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', icons[name]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function signal() {
  const marker = element('i', '', 'signal');
  marker.setAttribute('aria-hidden', 'true');
  return marker;
}

function journalNode(role, title, detail, state, updated = false) {
  const node = element('div', '', 'node ' + role);
  node.dataset.tone = tone(state);
  if (state === 'agent-running') node.dataset.running = 'true';
  if (updated) node.dataset.update = 'true';
  const badge = element('div', '', 'node-icon');
  badge.append(icon(role));
  const info = element('div');
  info.append(element('strong', title), element('small', detail));
  node.append(badge, info);
  return node;
}

function edge(direction, updated) {
  const node = element('div', '', 'edge');
  node.setAttribute('aria-hidden', 'true');
  node.dataset.direction = direction;
  if (updated) node.dataset.animate = direction;
  return node;
}

function listEntry(entry) {
  const button = element('button', '', 'entry');
  button.type = 'button';
  button.dataset.entry = entry.key;
  button.setAttribute('aria-pressed', String(entry.key === selected));
  const reviewState = entry.task && entry.review && entry.review.state !== entry.state ? states[entry.review.state] : null;
  const running = entry.task?.agents.filter(agent => agent.state === 'agent-running').length ?? 0;
  const agents = running ? `${running} ${running === 1 ? 'agent running' : 'agents running'}` : null;
  const status = element('span', '', 'entry-state');
  status.append(signal(), element('span', [states[entry.state], agents, reviewState].filter(Boolean).join(' · ')));
  status.dataset.tone = tone(waiting.has(entry.state) ? entry.state : entry.review?.state ?? entry.state);
  if (entry.updated.size) button.dataset.update = 'true';
  const meta = [entry.project.name, entry.task?.branch].filter(Boolean).join(' · ');
  button.append(element('span', entry.title, 'entry-title'), element('span', meta, 'entry-meta'), status);
  button.addEventListener('click', () => {
    selected = entry.key;
    for (const item of document.querySelectorAll('.entry')) item.setAttribute('aria-pressed', String(item === button));
    renderDetail({ ...entry, updated: new Set() });
  });
  return button;
}

function renderDetail(entry) {
  const panel = document.getElementById('detail');
  const activity = document.getElementById('activity');
  const link = document.getElementById('pr-link');
  link.hidden = true;
  link.removeAttribute('href');
  if (!entry) {
    text('detail-title', 'Session details');
    text('detail-state', '');
    text('activity-caption', '');
    panel.replaceChildren(element('p', 'Sessions appear after their first Crew checkpoint.', 'empty'));
    activity.replaceChildren(element('p', 'Select a session to see its checkpoints.', 'empty'));
    return;
  }
  const { task, review, project } = entry;
  text('detail-title', entry.title);
  text('detail-state', 'Last recorded state · ' + states[entry.state]);
  text('activity-caption', 'Session, agent and review history');
  const repository = review?.repository ?? project.repository;
  const number = review?.number ?? task?.prNumber;
  if (Number.isSafeInteger(number) && /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_.-]*$/i.test(repository ?? '')) {
    link.href = `https://github.com/${repository}/pull/${number}`;
    link.textContent = `Open PR #${number}`;
    link.hidden = false;
  }

  const graph = element('div', '', 'canvas');
  graph.setAttribute('role', 'group');
  graph.setAttribute('aria-label', 'Recorded crew workflow');
  const taskEvent = task?.events.at(-1);
  const reviewEvent = review?.events.at(-1);
  const taskUpdated = taskEvent !== undefined && entry.updated.has(eventKey(taskEvent));
  const reviewUpdated = reviewEvent !== undefined && entry.updated.has(eventKey(reviewEvent));
  if (task) {
    graph.append(journalNode('coordinator', 'Coordinator', 'Task assignment'), edge('forward', taskUpdated && task.stage === 'assigned'),
      journalNode('session', 'Task session', states[task.stage], task.stage, taskUpdated));
    for (const agent of task.agents) {
      const updated = entry.updated.has(eventKey({ ...agent, type: 'agent', agentId: agent.id }));
      graph.append(edge(agent.state === 'agent-running' ? 'forward' : 'return', updated),
        journalNode('agent', agent.label, `${states[agent.state]} · ${when(agent.at)}`, agent.state, updated));
    }
  }
  if (review) {
    if (task) graph.append(edge(review.state === 'changes_requested' || review.state === 'approved' ? 'return' : 'forward', reviewUpdated));
    graph.append(journalNode('review', 'Independent reviewer', [states[review.state], review.model ?? review.runtime].filter(Boolean).join(' · '), review.state, reviewUpdated));
  }

  const facts = element('dl', '', 'facts');
  const details = [['Repository', project.name], ['Branch', task?.branch], ['Worktree', task?.worktree],
    ['Codex session ID', task?.threadId], ['Last recorded', when(entry.at)]];
  for (const [name, value] of details) if (value) facts.append(element('dt', name), element('dd', value));
  const timeline = element('ol', '', 'timeline');
  for (const event of entry.events) {
    const row = element('li');
    row.dataset.tone = tone(event.state);
    if (entry.updated.has(eventKey(event))) row.dataset.update = 'true';
    const source = event.type === 'review' ? `Reviewer${event.round ? ' · Round ' + event.round : ''}` : event.label ?? 'Task session';
    const stamp = element('time', when(event.at));
    if (Number.isFinite(Date.parse(event.at))) stamp.dateTime = event.at;
    const detail = element('div');
    detail.append(element('strong', states[event.state]), element('span', source, 'event-source'), stamp);
    row.append(signal(), detail);
    timeline.append(row);
  }
  panel.replaceChildren(graph, facts);
  activity.replaceChildren(timeline);
}

function eventKey(event) { return `${event.type}:${event.agentId ?? ''}:${event.revision}:${event.at}`; }

function render(animate = false) {
  const matches = project => picker.value === 'all' || String(project.id) === picker.value;
  const projects = payload.projects.filter(matches);
  const allTasks = [], allUnlinked = [];
  for (const project of payload.projects) {
    const reviews = new Map(project.pullRequests.map(review => [`${review.repository.toLowerCase()}#${review.number}`, review]));
    const linked = new Set();
    for (const task of project.tasks) {
      const ref = `${project.repository?.toLowerCase()}#${task.prNumber}`;
      const review = reviews.get(ref);
      if (review) linked.add(ref);
      allTasks.push({ key: `${project.id}/task/${task.id}`, title: task.title ?? task.id,
        state: task.stage, at: review?.at > task.at ? review.at : task.at, task, review, project });
    }
    for (const [ref, review] of reviews) if (!linked.has(ref)) {
      allUnlinked.push({ key: `${project.id}/review/${ref}`, title: `PR #${review.number}`, state: review.state,
        at: review.at, review, project });
    }
  }
  const recorded = new Map();
  for (const entry of [...allTasks, ...allUnlinked]) {
    const events = [...(entry.task?.events ?? []), ...(entry.review?.events ?? [])].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
    const known = previous.get(entry.key);
    const mayAnimate = animate && !paused && !motionPreference.matches && document.visibilityState === 'visible';
    // New entries show only their latest signal. Initial history and filter changes stay still.
    entry.updated = new Set(mayAnimate ? (known ? events.filter(event => !known.has(eventKey(event))) : events.slice(0, 1)).map(eventKey) : []);
    entry.events = events;
    recorded.set(entry.key, new Set(events.map(eventKey)));
  }
  previous = recorded;
  const sortByDate = (a, b) => (b.at ?? '').localeCompare(a.at ?? '');
  const tasks = allTasks.filter(entry => matches(entry.project)).sort(sortByDate);
  const unlinked = allUnlinked.filter(entry => matches(entry.project)).sort(sortByDate);
  const all = [...tasks, ...unlinked];
  const focus = all.find(entry => entry.key === selected) ?? all[0];
  selected = focus?.key ?? null;
  text('project-count', `${projects.length} ${projects.length === 1 ? 'repository' : 'repositories'} · Local journals`);
  text('open-count', tasks.filter(entry => !closed.has(entry.state)).length);
  text('waiting-count', all.filter(entry => entry.state === 'waiting-human' || entry.review?.state === 'awaiting-auth').length);
  text('merged-count', tasks.filter(entry => entry.state === 'merged').length);
  text('session-count', tasks.length);
  const warning = document.getElementById('warning');
  warning.hidden = !projects.some(project => project.unavailable);
  warning.textContent = warning.hidden ? '' : 'Some journal records could not be read. The remaining activity is still shown.';
  const activeRow = document.activeElement?.dataset?.entry;
  document.getElementById('sessions').replaceChildren(...(tasks.length ? tasks.map(listEntry) : [element('p', 'No task checkpoints yet.', 'empty')]));
  document.getElementById('unlinked').hidden = !unlinked.length;
  document.getElementById('reviews').replaceChildren(...unlinked.map(listEntry));
  if (activeRow) [...document.querySelectorAll('.entry')].find(button => button.dataset.entry === activeRow)?.focus({ preventScroll: true });
  renderDetail(focus);
}

async function refresh() {
  try {
    const response = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4500) });
    if (response.status === 401) {
      connect('offline', 'Open the full dashboard link printed in your terminal');
      return;
    }
    if (!response.ok) throw new Error('Dashboard unavailable');
    const body = await response.text();
    if (body !== snapshot) {
      const next = JSON.parse(body);
      const selectedProject = picker.value;
      if (JSON.stringify(next.projects.map(({ id, name }) => [id, name])) !== JSON.stringify(payload.projects.map(({ id, name }) => [id, name]))) {
        picker.replaceChildren(new Option('All repositories', 'all'), ...next.projects.map(project => new Option(project.name, project.id)));
        if ([...picker.options].some(option => option.value === selectedProject)) picker.value = selectedProject;
      }
      payload = next;
      const animate = Boolean(snapshot);
      snapshot = body;
      render(animate);
    }
    connect('online', 'Journal connected');
  } catch {
    connect('offline', 'Disconnected · Showing last snapshot');
  }
  setTimeout(refresh, 2500);
}

function updateMotion() {
  const reduced = motionPreference.matches;
  document.documentElement.dataset.motion = paused || reduced ? 'paused' : 'on';
  motion.disabled = reduced;
  motion.setAttribute('aria-pressed', String(paused || reduced));
  motion.textContent = reduced ? 'Reduced motion' : paused ? 'Resume motion' : 'Pause motion';
}

document.getElementById('skip-link').addEventListener('click', event => {
  event.preventDefault();
  document.getElementById('dashboard').focus();
});
motion.addEventListener('click', () => { paused = !paused; updateMotion(); render(); });
motionPreference.addEventListener('change', () => { updateMotion(); render(); });
picker.addEventListener('change', () => render());
updateMotion();
render();
await refresh();
