import { readFileSync } from 'node:fs';
import { checkpoint, history, initProject, latestRecord, loadConfig, rootDir, taskDirectory } from './project.mjs';
import { managePull } from './pull-request.mjs';
import { invokeSpecialist } from './runtime.mjs';

const usage = `Usage: node method.mjs COMMAND [ARGUMENTS]

  init OWNER/REPO BASE_BRANCH
  config
  checkpoint TASK_ID EXPECTED_REVISION STAGE NOTE_FILE
  status TASK_ID
  history TASK_ID
  ux REQUEST_FILE
  review OWNER/REPO PR BRIEF_FILE
  review-status OWNER/REPO PR
  recover-review OWNER/REPO PR EXPECTED_REVISION
  verify OWNER/REPO PR
  merge OWNER/REPO PR`;

function run([command, ...args]) {
  const arity = { init: 2, config: 0, checkpoint: 4, status: 1, history: 1, ux: 1, review: 3,
    'review-status': 2, 'recover-review': 3, verify: 2, merge: 2 };
  if (!Object.hasOwn(arity, command) || args.length !== arity[command]) throw new Error(usage);
  const cwd = rootDir();
  switch (command) {
    case 'init': return { path: initProject(args[0], args[1], cwd) };
    case 'config': return loadConfig(cwd);
    case 'checkpoint': {
      if (!/^(0|[1-9]\d*)$/.test(args[1])) throw new Error('Expected a nonnegative revision.');
      return checkpoint(cwd, args[0], Number(args[1]), args[2], args[3]);
    }
    case 'status': return latestRecord(taskDirectory(args[0], cwd));
    case 'history': return history(taskDirectory(args[0], cwd));
    case 'ux': {
      const { runtime, model, effort, skills } = loadConfig(cwd).roles.ux;
      const { brief, files, context } = JSON.parse(readFileSync(args[0], 'utf8').replace(/^\uFEFF/, ''));
      return invokeSpecialist({ role: 'ux', cwd, brief, files, context, model, effort, skills }, runtime);
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
