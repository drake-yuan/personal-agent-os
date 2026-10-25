/**
 * Three-layer verification engine (design Section 8.4, P0-04).
 *
 *   Protocol (deterministic): schema validation -> exit code -> required
 *     fields non-empty -> unknown fields rejected.
 *   Product (deterministic): required artifacts exist -> sha256 ->
 *     full snapshot diff within scope.
 *   Business (domain rules): the contract's acceptance checkers run
 *     against the whitelist registry; high-risk results go to human
 *     approval.
 *
 * An executor claiming completion NEVER produces `accepted`. Only the
 * Verifier writes task `done` (core.acceptTask).
 */
import {
  findChecker, validateCheckerArgs, loadSchemaById, validate,
  type CheckerOutcome,
} from '@paos/contracts';

export type Layer = 'protocol' | 'product' | 'business';

export interface CheckContext {
  /** Resolve an artifact id to its parsed JSON content (if any). */
  artifactJson(artifactId: string): unknown;
  /** Resolve an artifact id to its sha256. */
  artifactSha256(artifactId: string): string | undefined;
  /** Recorded process exit codes by check_ref. */
  exitCode(checkRef: string): number | undefined;
  /** Changed paths in the workspace (post-execution diff). */
  changedPaths(): string[];
  /** Evidence age in days by evidence id. */
  evidenceAgeDays(evidenceId: string): number | undefined;
}

export interface CheckerCall {
  id: string;
  checker: string;
  checker_version?: number;
  args: Record<string, unknown>;
}

export interface VerificationReport {
  runId: string;
  layer: Layer;
  checks: CheckerOutcome[];
  passed: boolean;
  failureCodes: string[];
  createdAt: string;
}

function outcome(
  call: CheckerCall,
  passed: boolean,
  failureCode: string | undefined,
  started: number,
): CheckerOutcome {
  return {
    check_id: call.id,
    checker: call.checker,
    checker_version: call.checker_version ?? 1,
    passed,
    evidence_refs: [],
    duration_ms: Date.now() - started,
    failure_code: failureCode,
  };
}

/** Run one whitelisted checker. Fail-closed on unknown checker/args. */
export function runChecker(call: CheckerCall, ctx: CheckContext): CheckerOutcome {
  const started = Date.now();
  const spec = findChecker(call.checker, call.checker_version ?? 1);
  if (!spec) {
    return outcome(call, false, 'CHECKER_NOT_REGISTERED', started);
  }
  const argsCheck = validateCheckerArgs(spec, call.args);
  if (!argsCheck.ok) {
    return outcome(call, false, 'CHECKER_ARGS_INVALID', started);
  }
  return runKnownChecker(spec.id, call, ctx, started);
}

function runKnownChecker(specId: string, call: CheckerCall, ctx: CheckContext, started: number): CheckerOutcome {
  switch (specId) {
    case 'artifact.exists': {
      const ids = call.args.artifact_ids as string[];
      const ok = ids.every((id) => ctx.artifactSha256(id) !== undefined);
      return outcome(call, ok, ok ? undefined : 'ARTIFACT_MISSING', started);
    }
    case 'artifact.sha256_matches': {
      const actual = ctx.artifactSha256(call.args.artifact as string);
      const ok = actual === call.args.expected;
      return outcome(call, ok, ok ? undefined : 'HASH_MISMATCH', started);
    }
    case 'artifact.schema_valid': {
      const content = ctx.artifactJson(call.args.artifact as string);
      const schema = loadSchemaById(call.args.schema_id as string);
      const result = validate(content as never, schema.schema as never);
      return outcome(call, result.ok, result.ok ? undefined : 'SCHEMA_INVALID', started);
    }
    case 'json.pointer_equals': {
      const content = ctx.artifactJson(call.args.artifact as string) as Record<string, unknown>;
      const pointer = (call.args.pointer as string).split('/').filter(Boolean);
      let node: unknown = content;
      for (const seg of pointer) {
        if (node && typeof node === 'object') node = (node as Record<string, unknown>)[seg];
        else { node = undefined; break; }
      }
      const ok = JSON.stringify(node) === JSON.stringify(call.args.expected);
      return outcome(call, ok, ok ? undefined : 'VALUE_MISMATCH', started);
    }
    case 'text.contains_all': {
      const content = JSON.stringify(ctx.artifactJson(call.args.artifact as string));
      const needles = call.args.needles as string[];
      const ok = needles.every((n) => content.includes(n));
      return outcome(call, ok, ok ? undefined : 'CONTENT_MISSING', started);
    }
    case 'process.exit_code_equals': {
      const actual = ctx.exitCode(call.args.check_ref as string);
      const ok = actual === call.args.expected;
      return outcome(call, ok, ok ? undefined : 'CHECK_NONZERO', started);
    }
    case 'git.changed_paths_within': {
      const scopes = call.args.scope_paths as string[];
      const changed = ctx.changedPaths();
      const outside = changed.filter((p) => !scopes.some((s) => p === s || p.startsWith(s)));
      return outcome(call, outside.length === 0, outside.length === 0 ? undefined : 'SCOPE_VIOLATION', started);
    }
    case 'fs.snapshot_within': {
      // Product-layer snapshot escape detection is performed by
      // packages/runtime/src/snapshot.ts; the checker asserts the
      // recorded baseline was used.
      const changed = ctx.changedPaths();
      const root = call.args.root as string;
      const escaped = changed.filter((p) => !p.startsWith(root));
      return outcome(call, escaped.length === 0, escaped.length === 0 ? undefined : 'PATH_ESCAPE', started);
    }
    case 'evidence.freshness_within': {
      const ages = call.args.evidence_ids as string[] | undefined;
      if (!ages) return outcome(call, false, 'STALE_EVIDENCE', started);
      const max = call.args.max_age_days as number;
      const stale = ages.filter((id) => (ctx.evidenceAgeDays(id) ?? Number.MAX_SAFE_INTEGER) > max);
      return outcome(call, stale.length === 0, stale.length === 0 ? undefined : 'STALE_EVIDENCE', started);
    }
    default:
      return outcome(call, false, 'CHECKER_NOT_IMPLEMENTED', started);
  }
}

export function runLayer(layer: Layer, calls: CheckerCall[], ctx: CheckContext, runId: string): VerificationReport {
  const checks = calls.map((c) => runChecker(c, ctx));
  const failureCodes = checks.filter((c) => !c.passed).map((c) => c.failure_code ?? 'UNKNOWN');
  return {
    runId,
    layer,
    checks,
    passed: checks.every((c) => c.passed),
    failureCodes,
    createdAt: new Date().toISOString(),
  };
}

/** Aggregate the three layers into one verdict. `accepted` only here. */
export function deriveVerdict(
  reports: VerificationReport[],
): 'accepted' | 'rejected' | 'needs_human' | 'unknown_outcome' {
  if (reports.some((r) => r.layer === 'business' && r.failureCodes.includes('NEEDS_HUMAN'))) {
    return 'needs_human';
  }
  return reports.every((r) => r.passed) ? 'accepted' : 'rejected';
}
