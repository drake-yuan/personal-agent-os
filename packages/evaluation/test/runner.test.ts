import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  gateScenarioCoverage, gateCaseIntegrity, gateMatrixCoverage,
  ALL_DETERMINISTIC_GATES, allGatesPass, coverageReport, type GateCase,
} from '../src/gates.js';
import { parseCases, runGateSuite, formatSuite } from '../src/runner.js';

function tmpDir(): string {
  return mkdtempSync(path.join(process.env.TMPDIR ?? process.env.TEMP ?? '.', 'paos-evals-'));
}

function writeCases(dir: string, cases: GateCase[]): string {
  const p = path.join(dir, 'cases.jsonl');
  writeFileSync(p, cases.map((c) => JSON.stringify(c)).join('\n'));
  return p;
}

const OK_CASES: GateCase[] = [
  { id: 'a', scenario: 'success', description: 'd1' },
  { id: 'b', scenario: 'missing-input', description: 'd2' },
  { id: 'c', scenario: 'timeout-disconnect', description: 'd3' },
];

describe('additional deterministic gates', () => {
  it('case-integrity rejects empty ids, duplicates and empty descriptions', () => {
    const bad: GateCase[] = [
      { id: '', scenario: 'success', description: 'd' },
      { id: 'x', scenario: 'success', description: 'd' },
      { id: 'x', scenario: 'missing-input', description: 'd' },
      { id: 'y', scenario: 'missing-input', description: '  ' },
    ];
    const result = gateCaseIntegrity(bad);
    expect(result.failed).toBe(3);
    expect(result.failures.map((f) => f.reason)).toEqual([
      'case id is empty',
      'duplicate case id x',
      'case y has no description',
    ]);
    expect(gateCaseIntegrity(OK_CASES).failed).toBe(0);
  });

  it('matrix-coverage fails a suite that leaves a scenario untested', () => {
    const result = gateMatrixCoverage(OK_CASES);
    expect(result.failed).toBe(9);
    expect(result.failures.some((f) => f.reason.includes('prompt-injection'))).toBe(true);
    expect(allGatesPass([result])).toBe(false);
  });

  it('the registered gate set contains exactly the shipped gates', () => {
    expect(ALL_DETERMINISTIC_GATES).toHaveLength(3);
    const names = ALL_DETERMINISTIC_GATES.map((g) => g(OK_CASES).gate);
    expect(names).toEqual(['scenario-coverage', 'case-integrity', 'matrix-coverage']);
  });

  it('scenario-coverage stays separate from case-integrity', () => {
    // An unknown scenario must fail coverage, not integrity.
    const bad: GateCase[] = [{ id: 'z', scenario: 'nope' as never, description: 'd' }];
    expect(gateScenarioCoverage(bad).failed).toBe(1);
    expect(gateCaseIntegrity(bad).failed).toBe(0);
  });
});

describe('JSONL parsing', () => {
  it('skips blank lines and reports malformed lines without aborting', () => {
    const { cases, parseFailures } = parseCases(
      '{"id":"a","scenario":"success","description":"d"}\n\n{not json}\n',
    );
    expect(cases).toHaveLength(1);
    expect(parseFailures).toHaveLength(1);
    expect(parseFailures[0]?.caseId).toBe('line 3');
  });
});

describe('gate suite runner', () => {
  it('fails closed when a line cannot be parsed', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'cases.jsonl');
    writeFileSync(
      p,
      `${OK_CASES.map((c) => JSON.stringify(c)).join('\n')}\n{broken}\n`,
    );
    const result = runGateSuite({ root: dir, casesPath: p, writeReport: false });
    expect(result.ok).toBe(false);
    expect(result.caseCount).toBe(3);
    const integrity = result.results.find((r) => r.gate === 'case-integrity');
    expect(integrity?.failed).toBe(1);
  });

  it('passes a full 12-scenario suite and writes a report next to the data dir', () => {
    const dir = tmpDir();
    const full = ([
      'success', 'missing-input', 'contradictory-input', 'external-agent-failure',
      'partial-artifacts', 'schema-failure', 'timeout-disconnect', 'permission-violation',
      'prompt-injection', 'retry-cancel', 'user-rejection', 'version-incompatible',
    ] as const).map((s, i) => ({ id: `c${i}`, scenario: s, description: `d${i}` }));
    const p = writeCases(dir, full);
    const reportDir = path.join(dir, 'eval-runs');
    const result = runGateSuite({ root: dir, casesPath: p, reportDir });
    expect(result.ok).toBe(true);
    expect(result.reportPath).toBeDefined();
    expect(Object.values(result.coverage).every((n) => n === 1)).toBe(true);
  });

  it('reports uncovered scenarios in the human-readable verdict', () => {
    const dir = tmpDir();
    const result = runGateSuite({ root: dir, casesPath: writeCases(dir, OK_CASES), writeReport: false });
    const out = formatSuite(result, dir);
    expect(out).toContain('verdict: FAIL');
    expect(out).toContain('uncovered scenarios:');
    expect(out).toContain('prompt-injection');
  });

  it('throws a resolvable error when the case file is missing', () => {
    expect(() => runGateSuite({ root: tmpDir(), writeReport: false })).toThrow(/cases not found/);
  });
});
