import { describe, it, expect } from 'vitest';
import {
  validateCockpitSnapshot,
  validateCockpitSummary,
  DriftError,
  COCKPIT_DISTRIBUTION_ENUMS,
  type CockpitSnapshot,
} from '../src/index.js';

function validSnapshot(): CockpitSnapshot {
  return {
    generatedAt: '2026-10-30T00:00:00.000Z',
    dataDir: '/tmp/paos',
    summary: {
      sqliteVersion: '3.51.2',
      taskCount: 1,
      runCount: 0,
      pendingApprovalCount: 0,
      dispatchCount: 0,
      tasksByStatus: { done: 1 },
      tasksByRisk: { R1: 1 },
      runsByStatus: {},
      dispatchByState: {},
    },
    tasks: [{ id: 'T-1' }] as CockpitSnapshot['tasks'],
    workflowRuns: [],
    dispatchIntents: [],
    approvals: [],
  };
}

describe('validateCockpitSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    expect(() => validateCockpitSnapshot(validSnapshot())).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateCockpitSnapshot(42)).toThrow(DriftError);
  });

  it('rejects a missing summary', () => {
    const s = validSnapshot() as Record<string, unknown>;
    delete s.summary;
    expect(() => validateCockpitSnapshot(s)).toThrow(/summary/);
  });

  it('rejects a non-string generatedAt', () => {
    const s = validSnapshot() as Record<string, unknown>;
    s.generatedAt = 123;
    expect(() => validateCockpitSnapshot(s)).toThrow(/generatedAt/);
  });

  it('rejects a non-array tasks', () => {
    const s = validSnapshot() as Record<string, unknown>;
    s.tasks = 'nope';
    expect(() => validateCockpitSnapshot(s)).toThrow(/tasks/);
  });

  it('collects multiple summary issues', () => {
    const summary = {
      sqliteVersion: 9,
      taskCount: 'x',
      runCount: 0,
      pendingApprovalCount: 0,
      dispatchCount: 0,
      tasksByStatus: {},
      tasksByRisk: {},
      runsByStatus: {},
      dispatchByState: 'bad',
    };
    let err: unknown;
    try {
      validateCockpitSummary(summary);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DriftError);
    const issues = (err as DriftError).issues;
    expect(issues.some((i) => i.includes('sqliteVersion'))).toBe(true);
    expect(issues.some((i) => i.includes('taskCount'))).toBe(true);
    expect(issues.some((i) => i.includes('dispatchByState'))).toBe(true);
  });
});

describe('COCKPIT_DISTRIBUTION_ENUMS', () => {
  it('maps exactly the four summary distribution fields to enum arrays', () => {
    expect(Object.keys(COCKPIT_DISTRIBUTION_ENUMS).sort()).toEqual(
      ['dispatchByState', 'runsByStatus', 'tasksByRisk', 'tasksByStatus'].sort(),
    );
    for (const values of Object.values(COCKPIT_DISTRIBUTION_ENUMS)) {
      expect(Array.isArray(values)).toBe(true);
      expect(values.length).toBeGreaterThan(0);
    }
  });
});
