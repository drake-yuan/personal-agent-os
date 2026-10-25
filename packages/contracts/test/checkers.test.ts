import { describe, expect, it } from 'vitest';
import { CHECKERS, findChecker, validateCheckerArgs } from '../src/checkers.js';

describe('checker registry (P0-04)', () => {
  it('registers the nine v1 checkers', () => {
    expect(CHECKERS).toHaveLength(9);
    expect(findChecker('git.changed_paths_within', 1)).toBeDefined();
    expect(findChecker('fs.snapshot_within', 1)).toBeDefined();
    expect(findChecker('process.exit_code_equals', 1)).toBeDefined();
    expect(findChecker('artifact.exists', 1)).toBeDefined();
    expect(findChecker('artifact.schema_valid', 1)).toBeDefined();
    expect(findChecker('artifact.sha256_matches', 1)).toBeDefined();
    expect(findChecker('json.pointer_equals', 1)).toBeDefined();
    expect(findChecker('text.contains_all', 1)).toBeDefined();
    expect(findChecker('evidence.freshness_within', 1)).toBeDefined();
  });

  it('unknown checker names and versions are not found (fail-closed)', () => {
    expect(findChecker('shell.exec', 1)).toBeUndefined();
    expect(findChecker('git.changed_paths_within', 2)).toBeUndefined();
    expect(findChecker('js.eval', 1)).toBeUndefined();
  });

  it('validates args per checker schema', () => {
    const spec = findChecker('git.changed_paths_within', 1)!;
    expect(validateCheckerArgs(spec, { scope_paths: ['src/'] }).ok).toBe(true);
    expect(validateCheckerArgs(spec, { scope_paths: [] }).ok).toBe(false);
    expect(validateCheckerArgs(spec, { scope_paths: 'src/' }).ok).toBe(false);
    expect(validateCheckerArgs(spec, { scope_paths: ['src/'], extra: 1 }).ok).toBe(false);
  });

  it('rejects external schema URLs in artifact.schema_valid args', () => {
    const spec = findChecker('artifact.schema_valid', 1)!;
    expect(validateCheckerArgs(spec, { artifact: 'a1', schema_id: 'https://evil/x.json' }).ok).toBe(false);
    expect(validateCheckerArgs(spec, { artifact: 'a1', schema_id: 'paos://schemas/change-summary/1.0.0' }).ok).toBe(true);
  });

  it('sha256 args must be 64 hex chars', () => {
    const spec = findChecker('artifact.sha256_matches', 1)!;
    expect(validateCheckerArgs(spec, { artifact: 'a1', expected: 'a'.repeat(64) }).ok).toBe(true);
    expect(validateCheckerArgs(spec, { artifact: 'a1', expected: 'short' }).ok).toBe(false);
  });
});
