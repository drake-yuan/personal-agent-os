/**
 * CLI entry for the deterministic eval gates:
 *   pnpm evals:deterministic
 *
 * Thin wrapper over the shared gate-suite runner, so this script and
 * `paos evals` can never drift apart. Exit code 1 on any failure.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { formatSuite, runGateSuite } from './runner.js';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const root = repoRoot();
const result = runGateSuite({ root });

console.log(
  `deterministic gates: ${result.results.map((r) => `${r.gate} ${r.passed}/${r.passed + r.failed}`).join(', ')}`,
);
console.log(formatSuite(result, root));
process.exit(result.ok ? 0 : 1);
