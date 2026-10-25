import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCENARIO_MATRIX, gateScenarioCoverage, coverageReport, allGatesPass,
  type GateCase,
} from '../src/gates.js';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const CASES: GateCase[] = readFileSync(path.join(repoRoot(), 'evals/cases.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as GateCase);

describe('deterministic eval gates (§17, P1-09)', () => {
  it('the shipped case file covers all 12 scenarios exactly once', () => {
    expect(CASES).toHaveLength(12);
    const report = coverageReport(CASES);
    for (const s of SCENARIO_MATRIX) {
      expect(report[s], s).toBe(1);
    }
  });

  it('scenario-coverage gate passes on the shipped cases', () => {
    const result = gateScenarioCoverage(CASES);
    expect(result.failed).toBe(0);
    expect(allGatesPass([result])).toBe(true);
  });

  it('unknown scenarios fail the gate (fail-closed)', () => {
    const bad: GateCase[] = [{ id: 'x', scenario: 'made-up' as never, description: '' }];
    const result = gateScenarioCoverage(bad);
    expect(result.failed).toBe(1);
    expect(allGatesPass([result])).toBe(false);
  });

  it('the scenario matrix itself has 12 entries', () => {
    expect(SCENARIO_MATRIX).toHaveLength(12);
    expect(new Set(SCENARIO_MATRIX).size).toBe(12);
  });
});
