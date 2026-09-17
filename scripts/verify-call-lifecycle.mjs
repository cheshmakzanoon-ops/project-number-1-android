/** Compatibility entry point for isolated call verification; never writes to the family backend. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.env.CI !== 'true' || !process.env.RUNNER_TEMP) {
  console.error('Run "Verify real browser integration" in GitHub Actions. This test requires a disposable Linux runner and never uses the live family deployment.');
  process.exitCode = 1;
} else if (process.env.CONVEX_URL || process.env.CONVEX_DEPLOY_KEY || process.env.CONVEX_DEPLOYMENT) {
  console.error('Refusing call verification with a configured external deployment. Use the isolated browser workflow without production credentials.');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync('bash', ['scripts/e2e/run-isolated.sh'], {
    cwd: root, env: { ...process.env, E2E_SUITE: 'calls' }, stdio: 'inherit',
  });
  if (result.error) console.error('The isolated browser runner could not start.');
  process.exitCode = result.status ?? 1;
}
