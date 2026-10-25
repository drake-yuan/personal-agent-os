/**
 * CLI entry for the deterministic eval gates:
 *   pnpm evals:deterministic
 *
 * Loads evals/cases.jsonl, runs the deterministic gates, writes the
 * report to data/eval-runs/. Exit code 1 on any failure.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gateScenarioCoverage, allGatesPass, type GateCase,
} from './gates.js';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const root = repoRoot();
const casesPath = path.join(root, 'evals', 'cases.jsonl');
const cases: GateCase[] = readFileSync(casesPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as GateCase);

const results = [gateScenarioCoverage(cases)];
const ok = allGatesPass(results);

const reportDir = path.join(root, 'data', 'eval-runs');
mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `gates-${Date.now()}.json`);
writeFileSync(reportPath, JSON.stringify({ results, cases: cases.length }, null, 2));

console.log(`deterministic gates: ${results.map((r) => `${r.gate} ${r.passed}/${r.passed + r.failed}`).join(', ')}`);
console.log(`report: ${path.relative(root, reportPath)}`);
process.exit(ok ? 0 : 1);
