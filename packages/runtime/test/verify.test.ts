import { describe, expect, it } from 'vitest';
import { runChecker, runLayer, deriveVerdict, type CheckContext } from '../src/verify.js';
import type { CheckerCall } from '../src/verify.js';

function ctx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    artifactJson: () => ({}),
    artifactSha256: () => undefined,
    exitCode: () => 0,
    changedPaths: () => [],
    evidenceAgeDays: () => 0,
    ...overrides,
  };
}

const CALL: CheckerCall = { id: 'c1', checker: 'process.exit_code_equals', args: { check_ref: 'test', expected: 0 } };

describe('three-layer verification engine (Section 8.4)', () => {
  it('unregistered checker fails closed', () => {
    const r = runChecker({ id: 'c', checker: 'shell.exec', args: {} }, ctx());
    expect(r.passed).toBe(false);
    expect(r.failure_code).toBe('CHECKER_NOT_REGISTERED');
  });

  it('invalid args fail closed', () => {
    const r = runChecker({ id: 'c', checker: 'git.changed_paths_within', args: { scope_paths: 'src/' } }, ctx());
    expect(r.passed).toBe(false);
    expect(r.failure_code).toBe('CHECKER_ARGS_INVALID');
  });

  it('process.exit_code_equals detects nonzero exits', () => {
    expect(runChecker(CALL, ctx({ exitCode: () => 0 })).passed).toBe(true);
    const bad = runChecker(CALL, ctx({ exitCode: () => 1 }));
    expect(bad.passed).toBe(false);
    expect(bad.failure_code).toBe('CHECK_NONZERO');
  });

  it('artifact checks detect missing artifacts and hash mismatches', () => {
    const missing = runChecker(
      { id: 'a', checker: 'artifact.exists', args: { artifact_ids: ['x1'] } },
      ctx({ artifactSha256: () => undefined }),
    );
    expect(missing.failure_code).toBe('ARTIFACT_MISSING');
    const hash = runChecker(
      { id: 'h', checker: 'artifact.sha256_matches', args: { artifact: 'x1', expected: 'a'.repeat(64) } },
      ctx({ artifactSha256: () => 'b'.repeat(64) }),
    );
    expect(hash.failure_code).toBe('HASH_MISMATCH');
  });

  it('git.changed_paths_within flags out-of-scope changes', () => {
    const call: CheckerCall = { id: 'g', checker: 'git.changed_paths_within', args: { scope_paths: ['src/', 'tests/'] } };
    const ok = runChecker(call, ctx({ changedPaths: () => ['src/a.ts', 'tests/b.spec.ts'] }));
    expect(ok.passed).toBe(true);
    const violation = runChecker(call, ctx({ changedPaths: () => ['src/a.ts', 'secrets/env.txt'] }));
    expect(violation.failure_code).toBe('SCOPE_VIOLATION');
  });

  it('json.pointer_equals reads nested values', () => {
    const call: CheckerCall = { id: 'j', checker: 'json.pointer_equals', args: { artifact: 'r', pointer: '/a/b', expected: 42 } };
    const ok = runChecker(call, ctx({ artifactJson: () => ({ a: { b: 42 } }) }));
    expect(ok.passed).toBe(true);
    const bad = runChecker(call, ctx({ artifactJson: () => ({ a: { b: 43 } }) }));
    expect(bad.failure_code).toBe('VALUE_MISMATCH');
  });

  it('layers aggregate into a verdict; only all-pass gives accepted', () => {
    const pass = runLayer('protocol', [CALL], ctx({ exitCode: () => 0 }), 'w1');
    expect(pass.passed).toBe(true);
    const fail = runLayer('product', [{ id: 'f', checker: 'artifact.exists', args: { artifact_ids: ['x'] } }], ctx(), 'w1');
    expect(fail.passed).toBe(false);
    expect(deriveVerdict([pass])).toBe('accepted');
    expect(deriveVerdict([pass, fail])).toBe('rejected');
    const needsHuman = runLayer('business', [CALL], ctx({ exitCode: () => 0 }), 'w1');
    needsHuman.failureCodes.push('NEEDS_HUMAN');
    expect(deriveVerdict([pass, needsHuman])).toBe('needs_human');
  });

  it('evidence.freshness_within flags stale evidence', () => {
    const call: CheckerCall = { id: 'e', checker: 'evidence.freshness_within', args: { max_age_days: 30, evidence_ids: ['ev1'] } };
    expect(runChecker(call, ctx({ evidenceAgeDays: () => 10 })).passed).toBe(true);
    expect(runChecker(call, ctx({ evidenceAgeDays: () => 90 })).failure_code).toBe('STALE_EVIDENCE');
  });
});
