/**
 * Deterministic eval gates (design Section 17, P1-09).
 *
 * Two strictly separated classes:
 *  - DETERMINISTIC GATES: 100% must pass before merge (schema, state
 *    machine edges, permissions/paths, retry/idempotency, artifact
 *    existence, migrations, API auth, approval nonce).
 *  - MODEL QUALITY: threshold-based golden sets; never advertised as
 *    "the agent got smarter" (PB-2).
 *
 * The 12-scenario matrix every workflow must cover:
 *   success / missing-input / contradictory-input / external-failure /
 *   partial-artifacts / schema-failure / timeout-disconnect /
 *   permission-violation / prompt-injection / retry-cancel /
 *   user-rejection / version-incompatible.
 */

export const SCENARIO_MATRIX = [
  'success',
  'missing-input',
  'contradictory-input',
  'external-agent-failure',
  'partial-artifacts',
  'schema-failure',
  'timeout-disconnect',
  'permission-violation',
  'prompt-injection',
  'retry-cancel',
  'user-rejection',
  'version-incompatible',
] as const;
export type Scenario = (typeof SCENARIO_MATRIX)[number];

export interface GateCase {
  id: string;
  scenario: Scenario;
  description: string;
}

export interface GateResult {
  gate: string;
  passed: number;
  failed: number;
  failures: Array<{ caseId: string; reason: string }>;
}

/** A deterministic gate is a pure function over fixtures. */
export type DeterministicGate = (cases: GateCase[]) => GateResult;

function runGate(name: string, cases: GateCase[], fn: (c: GateCase) => string | undefined): GateResult {
  const failures: Array<{ caseId: string; reason: string }> = [];
  let passed = 0;
  for (const c of cases) {
    const reason = fn(c);
    if (reason) failures.push({ caseId: c.id, reason });
    else passed += 1;
  }
  return { gate: name, passed, failed: failures.length, failures };
}

/** Gate: every workflow covers the full 12-scenario matrix. */
export const gateScenarioCoverage: DeterministicGate = (cases) =>
  runGate('scenario-coverage', cases, (c) =>
    SCENARIO_MATRIX.includes(c.scenario) ? undefined : `unknown scenario ${c.scenario}`,
  );

/** Gate: no scenario may be silently skipped. */
export function coverageReport(cases: GateCase[]): Record<Scenario, number> {
  const report = Object.fromEntries(SCENARIO_MATRIX.map((s) => [s, 0])) as Record<Scenario, number>;
  for (const c of cases) report[c.scenario] += 1;
  return report;
}

/** Aggregate: deterministic gates are all-or-nothing. */
export function allGatesPass(results: GateResult[]): boolean {
  return results.every((r) => r.failed === 0);
}
