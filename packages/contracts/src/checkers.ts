/**
 * CheckerSpec registry (design §8.2, P0-04).
 *
 * Acceptance = named, versioned, whitelisted checkers. Arbitrary shell
 * commands and arbitrary JS are forbidden. Every checker declares its
 * own JSON Schema for args and is fail-closed: an unregistered checker
 * name, an unknown arg field, or an external schema URL fails the check.
 */
import { validate, type ValidationResult } from './validate.js';

export interface CheckerSpec {
  id: string; // e.g. "git.changed_paths_within"
  version: number;
  argsSchema: Record<string, unknown>;
  deterministic: boolean;
  /** Failure codes this checker can emit (examples, not exhaustive). */
  failureCodes: string[];
  description: string;
}

export interface CheckerOutcome {
  check_id: string;
  checker: string;
  checker_version: number;
  passed: boolean;
  evidence_refs: string[];
  duration_ms: number;
  failure_code?: string;
}

export const CHECKERS: CheckerSpec[] = [
  {
    id: 'git.changed_paths_within',
    version: 1,
    deterministic: true,
    failureCodes: ['SCOPE_VIOLATION'],
    description: 'All changed paths in the workspace git diff must be inside scope_paths.',
    argsSchema: {
      type: 'object',
      required: ['scope_paths'],
      properties: { scope_paths: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      additionalProperties: false,
    },
  },
  {
    id: 'fs.snapshot_within',
    version: 1,
    deterministic: true,
    failureCodes: ['PATH_ESCAPE', 'UNTRACKED_OUTSIDE'],
    description: 'Full workspace snapshot diff must stay inside root; symlinks resolved.',
    argsSchema: {
      type: 'object',
      required: ['root', 'baseline_ref'],
      properties: {
        root: { type: 'string', minLength: 1 },
        baseline_ref: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'process.exit_code_equals',
    version: 1,
    deterministic: true,
    failureCodes: ['CHECK_NONZERO'],
    description: 'A recorded check process must have exited with the expected code.',
    argsSchema: {
      type: 'object',
      required: ['check_ref', 'expected'],
      properties: {
        check_ref: { type: 'string', minLength: 1 },
        expected: { type: 'integer', minimum: 0, maximum: 255 },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'artifact.exists',
    version: 1,
    deterministic: true,
    failureCodes: ['ARTIFACT_MISSING'],
    description: 'Every listed artifact id must exist in the artifact store.',
    argsSchema: {
      type: 'object',
      required: ['artifact_ids'],
      properties: { artifact_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      additionalProperties: false,
    },
  },
  {
    id: 'artifact.schema_valid',
    version: 1,
    deterministic: true,
    failureCodes: ['SCHEMA_INVALID'],
    description: 'Artifact content must validate against a paos:// schema id.',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'schema_id'],
      properties: {
        artifact: { type: 'string', minLength: 1 },
        schema_id: { type: 'string', format: 'schema-id' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'artifact.sha256_matches',
    version: 1,
    deterministic: true,
    failureCodes: ['HASH_MISMATCH'],
    description: 'Artifact bytes must hash to the expected sha256.',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'expected'],
      properties: {
        artifact: { type: 'string', minLength: 1 },
        expected: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'json.pointer_equals',
    version: 1,
    deterministic: true,
    failureCodes: ['VALUE_MISMATCH'],
    description: 'A JSON pointer inside an artifact must equal the expected value.',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'pointer', 'expected'],
      properties: {
        artifact: { type: 'string', minLength: 1 },
        pointer: { type: 'string', pattern: '^(/[^/]+)*$' },
        expected: {},
      },
      additionalProperties: false,
    },
  },
  {
    id: 'text.contains_all',
    version: 1,
    deterministic: true,
    failureCodes: ['CONTENT_MISSING'],
    description: 'A text artifact must contain every needle.',
    argsSchema: {
      type: 'object',
      required: ['artifact', 'needles'],
      properties: {
        artifact: { type: 'string', minLength: 1 },
        needles: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'evidence.freshness_within',
    version: 1,
    deterministic: true,
    failureCodes: ['STALE_EVIDENCE'],
    description: 'Referenced evidence must be younger than max_age_days.',
    argsSchema: {
      type: 'object',
      required: ['max_age_days', 'evidence_ids'],
      properties: {
        max_age_days: { type: 'integer', minimum: 1 },
        evidence_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      additionalProperties: false,
    },
  },
];

export function findChecker(id: string, version = 1): CheckerSpec | undefined {
  return CHECKERS.find((c) => c.id === id && c.version === version);
}

/** Validate checker args against the registered schema. Fail-closed. */
export function validateCheckerArgs(spec: CheckerSpec, args: unknown): ValidationResult {
  return validate(args as never, spec.argsSchema as never);
}
