import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep Git fixtures on the writable checkout volume, including inside a desktop sandbox.
const temporary = mkdtempSync(join(root, '.metodo-test-'));
try {
  const tests = readdirSync(join(root, 'tests')).filter(f => f.endsWith('.test.mjs')).sort();
  if (!tests.length) throw new Error('No offline tests found.');
  const result = spawnSync(process.execPath, ['--test', ...tests.map(f => join('tests', f))], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
}
