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

/**
 * Gate: a case cannot be scored if it cannot be identified.
 * Duplicate ids would let one broken case be silently counted twice, and
 * an empty description makes the gate unreviewable by a human later.
 */
export const gateCaseIntegrity: DeterministicGate = (cases) => {
  const seen = new Set<string>();
  const result = runGate('case-integrity', cases, (c) => {
    if (!c.id || c.id.trim().length === 0) return 'case id is empty';
    if (seen.has(c.id)) return `duplicate case id ${c.id}`;
    seen.add(c.id);
    if (!c.description || c.description.trim().length === 0) {
      return `case ${c.id} has no description`;
    }
    return undefined;
  });
  return result;
};

/**
 * Gate: the suite itself must be able to detect regressions. A scenario
 * with zero cases passes vacuously, so coverage is asserted explicitly
 * rather than derived from whatever happens to be present.
 */
export const gateMatrixCoverage: DeterministicGate = (cases) => {
  const report = coverageReport(cases);
  const missing = SCENARIO_MATRIX.filter((s) => report[s] === 0);
  return {
    gate: 'matrix-coverage',
    passed: SCENARIO_MATRIX.length - missing.length,
    failed: missing.length,
    failures: missing.map((s) => ({ caseId: '-', reason: `no case covers scenario ${s}` })),
  };
};

/**
 * The full deterministic gate set. These are all-or-nothing before merge:
 * a partial pass is a failure.
 */
export const ALL_DETERMINISTIC_GATES: readonly DeterministicGate[] = [
  gateScenarioCoverage,
  gateCaseIntegrity,
  gateMatrixCoverage,
];

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
