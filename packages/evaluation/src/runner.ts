/**
 * Gate suite runner.
 *
 * Shared by two entry points so they can never drift apart:
 *   - `pnpm evals:deterministic`  (packages/evaluation/src/run-gates.ts)
 *   - `paos evals`                (apps/cli)
 *
 * Deterministic gates are pure functions over fixtures: same input, same
 * verdict, no network, no model. They are all-or-nothing before merge.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALL_DETERMINISTIC_GATES, allGatesPass, coverageReport,
  type GateCase, type GateResult, type Scenario,
} from './gates.js';

/** Merged into this gate when the case file itself cannot be parsed. */
const CASE_INTEGRITY_GATE = 'case-integrity';

export interface GateSuiteOptions {
  /** Repository root; used to resolve defaults. */
  root: string;
  /** Override the default `evals/cases.jsonl`. */
  casesPath?: string;
  /** Where to write the JSON report. Disable with `writeReport: false`. */
  reportDir?: string;
  writeReport?: boolean;
}

export interface GateSuiteResult {
  ok: boolean;
  caseCount: number;
  coverage: Record<Scenario, number>;
  results: GateResult[];
  reportPath?: string;
}

/**
 * Parse JSONL into cases. A malformed line never aborts the suite: it is
 * recorded as a case-integrity failure so one bad line cannot hide the
 * verdict for the rest (fail-closed, but survivable).
 */
export function parseCases(jsonl: string): {
  cases: GateCase[];
  parseFailures: Array<{ caseId: string; reason: string }>;
} {
  const cases: GateCase[] = [];
  const parseFailures: Array<{ caseId: string; reason: string }> = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) continue;
    try {
      cases.push(JSON.parse(line) as GateCase);
    } catch (err) {
      parseFailures.push({
        caseId: `line ${i + 1}`,
        reason: `malformed JSONL: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { cases, parseFailures };
}

function defaultCasesPath(root: string): string {
  return path.join(root, 'evals', 'cases.jsonl');
}

/** Run every deterministic gate over the case file. */
export function runGateSuite(opts: GateSuiteOptions): GateSuiteResult {
  const casesPath = opts.casesPath ?? defaultCasesPath(opts.root);
  if (!existsSync(casesPath)) {
    throw new Error(`eval cases not found: ${casesPath}`);
  }
  const { cases, parseFailures } = parseCases(readFileSync(casesPath, 'utf8'));

  const results = ALL_DETERMINISTIC_GATES.map((gate) => gate(cases)).map((r) =>
    r.gate === CASE_INTEGRITY_GATE && parseFailures.length > 0
      ? {
          ...r,
          failed: r.failed + parseFailures.length,
          failures: [...r.failures, ...parseFailures],
        }
      : r,
  );
  const ok = allGatesPass(results);

  let reportPath: string | undefined;
  const writeReport = opts.writeReport ?? true;
  if (writeReport) {
    const reportDir = opts.reportDir ?? path.join(opts.root, 'data', 'eval-runs');
    mkdirSync(reportDir, { recursive: true });
    reportPath = path.join(reportDir, `gates-${Date.now()}.json`);
    writeFileSync(
      reportPath,
      JSON.stringify({ ok, cases: cases.length, coverage: coverageReport(cases), results }, null, 2),
    );
  }

  return { ok, caseCount: cases.length, coverage: coverageReport(cases), results, reportPath };
}

/** Human-readable verdict table for the CLI. */
export function formatSuite(result: GateSuiteResult, root: string): string {
  const lines = result.results.map((r) => {
    const status = r.failed === 0 ? 'PASS' : 'FAIL';
    return `${status}  ${r.gate.padEnd(20)} ${r.passed}/${r.passed + r.failed}`;
  });
  for (const r of result.results) {
    for (const f of r.failures) {
      lines.push(`      ${f.caseId}: ${f.reason}`);
    }
  }
  const uncovered = (Object.keys(result.coverage) as Scenario[])
    .filter((s) => result.coverage[s] === 0);
  lines.push(`cases: ${result.caseCount}   failures: ${result.results.reduce((n, r) => n + r.failed, 0)}`);
  if (uncovered.length > 0) lines.push(`uncovered scenarios: ${uncovered.join(', ')}`);
  if (result.reportPath) {
    lines.push(`report: ${path.relative(root, result.reportPath)}`);
  }
  lines.push(result.ok ? 'verdict: PASS' : 'verdict: FAIL');
  return lines.join('\n');
}
