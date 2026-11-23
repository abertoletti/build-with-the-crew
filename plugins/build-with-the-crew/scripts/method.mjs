import { readFileSync } from 'node:fs';
import { checkpoint, history, initProject, latestRecord, loadConfig, rootDir, taskDirectory } from './project.mjs';
import { managePull } from './pull-request.mjs';
import { invokeSpecialist } from './runtime.mjs';
import { listDecisions, openTasks, transitionDecision } from './decisions.mjs';
import { recordAgentEvent } from './agent-events.mjs';
import { checkRoleSkills, requireRoleSkills } from './role-skills.mjs';

const usage = `Usage: node method.mjs COMMAND [ARGUMENTS]

  init OWNER/REPO BASE_BRANCH
  config
  doctor [ROLE]
  checkpoint TASK_ID EXPECTED_REVISION STAGE NOTE_FILE [CONTEXT_FILE]
  status TASK_ID
  history TASK_ID
  open-tasks
  decisions
  decision-request TASK_ID DECISION_ID REQUEST_FILE
  decision-answer TASK_ID DECISION_ID ANSWER_FILE
  decision-ack TASK_ID DECISION_ID
  agent-event TASK_ID AGENT_ID STATE LABEL
  ux REQUEST_FILE
  review OWNER/REPO PR BRIEF_FILE
  review-status OWNER/REPO PR
  recover-review OWNER/REPO PR EXPECTED_REVISION
  verify OWNER/REPO PR
  merge OWNER/REPO PR`;

function run([command, ...args]) {
  const arity = { init: 2, config: 0, doctor: 0, checkpoint: 4, status: 1, history: 1, ux: 1, review: 3,
    'open-tasks': 0, decisions: 0, 'decision-request': 3, 'decision-answer': 3, 'decision-ack': 2, 'agent-event': 4,
    'review-status': 2, 'recover-review': 3, verify: 2, merge: 2 };
  const extended = (command === 'checkpoint' && args.length === 5) || (command === 'doctor' && args.length === 1);
  if (!Object.hasOwn(arity, command) || (args.length !== arity[command] && !extended)) throw new Error(usage);
  const cwd = rootDir();
  switch (command) {
    case 'init': return { path: initProject(args[0], args[1], cwd) };
    case 'config': return loadConfig(cwd);
    case 'doctor': {
      const { roles } = loadConfig(cwd);
      const selected = args[0];
      if (selected && (!Object.hasOwn(roles, selected) || !roles[selected].skills)) throw new Error('Unknown specialist role: ' + selected);
      const reports = Object.entries(roles).filter(([name, role]) => role.skills && (!selected || selected === name))
        .map(([name, role]) => checkRoleSkills(cwd, name, role));
      if (reports.some(report => report.status === 'blocked')) process.exitCode = 1;
      return { checkout: cwd, platform: process.platform, roles: reports };
    }
    case 'checkpoint': {
      if (!/^(0|[1-9]\d*)$/.test(args[1])) throw new Error('Expected a nonnegative revision.');
      return checkpoint(cwd, args[0], Number(args[1]), args[2], args[3], args[4]);
    }
    case 'status': return latestRecord(taskDirectory(args[0], cwd));
    case 'history': return history(taskDirectory(args[0], cwd));
    case 'open-tasks': return openTasks(cwd);
    case 'agent-event': return recordAgentEvent(cwd, ...args);
    case 'decisions': return listDecisions(cwd);
    case 'decision-request':
    case 'decision-answer':
    case 'decision-ack': return transitionDecision(cwd, command, args[0], args[1], args[2]);
    case 'ux': {
      const role = loadConfig(cwd).roles.ux;
      const { runtime, model, effort } = role;
      const report = requireRoleSkills(cwd, 'ux', role);
      const { brief, files, context } = JSON.parse(readFileSync(args[0], 'utf8').replace(/^\uFEFF/, ''));
      const skills = report.available.map(skill => skill.name);
      return invokeSpecialist({ role: 'ux', cwd, brief, files, context, model, effort, skills }, runtime, report);
    }
    default: return managePull(command, args[0], args[1], args[2], { cwd });
  }
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) console.log(usage);
  else console.log(JSON.stringify(run(args), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
