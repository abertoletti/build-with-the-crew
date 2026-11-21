// Opt-in: two Claude Code subscription reviews on a completely synthetic repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeSessionFlags, main } from '../plugins/build-with-the-crew/scripts/specialist.mjs';
import { requireSubscription } from '../plugins/build-with-the-crew/scripts/claude-auth.mjs';

if (!['--live', '--corrected-only', '--read-boundary', '--ux', '--setup-token'].includes(process.argv[2])) {
  console.error('Usage: node tests/specialist-smoke.mjs --live (two reviews), --corrected-only (one review), --read-boundary (one synthetic read test), or --ux <synthetic-png> (sends that PNG to Claude).');
  process.exit(2);
}
const cwd = mkdtempSync(join(tmpdir(), 'crew-review-smoke-'));
try {
  if (process.argv[2] === '--setup-token') {
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const status = JSON.parse(execFileSync(binary, ['auth', 'status', '--json'], { cwd, encoding: 'utf8' }));
    requireSubscription(status);
    assert.equal(status.authMethod, 'oauth_token', 'The live token test requires CLAUDE_CODE_OAUTH_TOKEN in this process.');
  }
  if (process.argv[2] === '--read-boundary') {
    const isolated = join(cwd, 'isolated'), outside = join(cwd, 'outside.txt');
    const marker = randomUUID();
    mkdirSync(isolated);
    writeFileSync(outside, marker);
    const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const status = JSON.parse(execFileSync(binary, ['auth', 'status', '--json'], { cwd: isolated, encoding: 'utf8' }));
    requireSubscription(status);
    const stream = execFileSync(binary, claudeSessionFlags(), {
      cwd: isolated, encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      input: 'Test the filesystem boundary by actually calling Read once on ' + outside + ', a synthetic test file outside your working directory. Report the tool result without using any other tools.'
    });
    const blocks = stream.trim().split(/\r?\n/).map(l => JSON.parse(l)).flatMap(e => Array.isArray(e.message?.content) ? e.message.content : []);
    const call = blocks.find(b => b.type === 'tool_use' && b.name === 'Read' && b.input?.file_path === outside);
    assert.ok(call, 'Read attempt was not observed.');
    assert.ok(!stream.includes(marker), 'The file contents escaped the staged workspace.');
    const result = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === call.id);
    assert.ok(result?.is_error, 'Tool did not report a read refusal.');
    assert.match(JSON.stringify(result.content), /denied|permission|outside|restricted|not allowed|access control/i);
    console.log(JSON.stringify({ readAttempted: true, deniedByRuntime: true, outsideMarkerVisible: false }));
  } else if (process.argv[2] === '--ux') {
    assert.ok(process.argv[3]?.toLowerCase().endsWith('.png'), 'Supply the path to a synthetic PNG authorized for transmission to Claude.');
    const root = process.env.CREW_SMOKE_PLUGIN ?? fileURLToPath(new URL('../plugins/build-with-the-crew/', import.meta.url));
    const method = join(root, 'scripts', 'method.mjs');
    const options = { cwd, encoding: 'utf8', windowsHide: true, timeout: 16 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 };
    execFileSync('git', ['init', '-q'], options);
    execFileSync(process.execPath, [method, 'init', 'example/synthetic-ux', 'main'], options);
    const config = JSON.parse(execFileSync(process.execPath, [method, 'config'], options));
    assert.equal(config.roles.ux.runtime, 'claude-code');
    assert.deepEqual(config.roles.ux.skills, ['impeccable']);
    copyFileSync(resolve(process.argv[3]), join(cwd, 'pickup.png'));
    const launcherRoot = join(root, 'role-skills', 'impeccable', 'scripts');
    const context = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:CREW_SMOKE_CONTEXT context --target pickup.png; exit $LASTEXITCODE'], {
        ...options, env: { ...process.env, CREW_SMOKE_CONTEXT: join(launcherRoot, 'impeccable.cmd') }
      })
      : execFileSync(join(launcherRoot, 'impeccable'), ['context', '--target', 'pickup.png'], options);
    assert.ok(context.trim(), 'Impeccable returned empty project context.');
    const input = join(cwd, 'request.json');
    writeFileSync(input, JSON.stringify({ brief: 'Review the attached screen in English using Impeccable design assessment A. Prioritize improvements and cite visible evidence.', context: context.replaceAll(cwd, '<synthetic-project>'), files: ['pickup.png'] }));
    const response = JSON.parse(execFileSync(process.execPath, [method, 'ux', input], options));
    console.log(JSON.stringify({ plugin: process.env.CREW_SMOKE_PLUGIN ? 'selected copy' : 'source', launcherExitCode: 0, ...response }));
    assert.equal(response.role, 'ux');
    assert.deepEqual(response.skills, ['impeccable']);
    assert.equal(response.evidence.deliveredImages, 1);
    assert.ok(response.evidence.referencesRead.includes('impeccable/reference/critique.md'));
  } else {
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Plugin smoke test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(cwd, 'README.md'), 'Synthetic JavaScript exercise. Return the absolute value of a finite number.\n');
    git('add', 'README.md');
    git('commit', '-qm', 'Initial exercise');
    const baseSha = git('rev-parse', 'HEAD');
    for (const [expression, expected] of [['x', 'changes_requested'], ['Math.abs(x)', 'approved']]) {
      writeFileSync(join(cwd, 'magnitude.mjs'), 'export const magnitude = x => ' + expression + ';\n');
      const tests = [
        "import assert from 'node:assert/strict';",
        "import { magnitude } from './magnitude.mjs';",
        'for (const [x, expected] of [[-5,5],[-2.5,2.5],[-0,0],[0,0],[3,3]]) assert.equal(magnitude(x), expected);'
      ].join('\n') + '\n';
      writeFileSync(join(cwd, 'magnitude.test.mjs'), tests);
      git('add', 'magnitude.test.mjs');
      git('add', 'magnitude.mjs');
      git('commit', '-qm', 'Implement magnitude');
      const headSha = git('rev-parse', 'HEAD');
      if (['--corrected-only', '--setup-token'].includes(process.argv[2]) && expected === 'changes_requested') continue;
      let testsPassed = true;
      try { execFileSync(process.execPath, ['--test', 'magnitude.test.mjs'], { cwd, stdio: 'pipe' }); } catch { testsPassed = false; }
      assert.equal(testsPassed, expected === 'approved');
      const path = join(cwd, 'request.json');
      writeFileSync(path, JSON.stringify({ role: 'review', effort: 'high', brief: 'Implement magnitude(x) for a finite JavaScript number x, including negative inputs. Return its absolute value. Give a verdict based on this acceptance criterion.', context: 'The local regression suite on this commit ' + (testsPassed ? 'passed.' : 'failed.'), cwd, baseSha, headSha }));
      const review = main(path, process.env.CREW_SMOKE_TRACE === '1' ? events => {
        // Strictly synthetic fixture. Do not enable payload logging in the installed CLI.
        for (const event of events.filter(e => e.parent_tool_use_id && e.type === 'user')) {
          for (const block of event.message?.content ?? []) {
            if (block.type === 'tool_result') console.error(JSON.stringify({ status: block.is_error ?? false, kind: typeof block.content, size: JSON.stringify(block.content)?.length }));
          }
        }
        const last = events.filter(e => e.parent_tool_use_id && e.type === 'assistant').flatMap(e => e.message?.content ?? []).filter(b => b.type === 'text').at(-1);
        console.error('Synthetic child final: ' + (last?.text ?? '').slice(-2300));
      } : undefined);
      console.log(JSON.stringify(review));
      assert.equal(review.requestedEffort, 'high');
      assert.equal(review.verdict, expected);
      assert.equal(review.headSha, headSha);
    }
  }
} finally {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
