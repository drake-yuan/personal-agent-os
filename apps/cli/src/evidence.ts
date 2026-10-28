/**
 * Real execution evidence for non-demo adapters.
 *
 * The demo adapter replays RECORDED fixtures, so its verification context
 * can (and must) come from those fixtures. A REAL adapter instead runs
 * against the live workspace, so handing it the demo evidence would verify
 * a run that never happened: it could only produce a meaningless verdict,
 * or worse, a false PASS if the workspace happened to match a fixture.
 *
 * This module derives evidence from the real workspace and from what the
 * adapter actually observed, and fails CLOSED wherever it cannot:
 *   - unknown artifact    -> `undefined` -> ARTIFACT_MISSING
 *   - unobserved exit code -> `undefined` -> CHECK_NONZERO
 *   - undeterminable diff  -> sentinel path -> SCOPE_VIOLATION
 * An empty diff would silently pass every scope check, so "unknown" is
 * never reported as "no changes".
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '@paos/adapters';
import type { CheckContext } from '@paos/runtime';

/** What a real dispatch observed, filled in as the run proceeds. */
export interface RunEvidence {
  exitCode?: number | null;
  providerTaskId?: string;
}

/**
 * Sentinel returned when the workspace diff cannot be determined (git
 * missing, or the workspace is not a repo). Scope checkers compare changed
 * paths against the allowed scope, so an unknown diff must fail.
 */
export const UNVERIFIABLE_PATH = '<unverifiable>';

const MS_PER_DAY = 86_400_000;

/**
 * Delegate to a real adapter while capturing what it observed.
 * Verification runs AFTER dispatch, but `CheckContext` is built BEFORE it;
 * the recorder bridges that gap so the context reads real post-run state.
 */
export function recordingAdapter(inner: AgentAdapter, evidence: RunEvidence): AgentAdapter {
  return {
    id: inner.id,
    provider: inner.provider,
    probe: () => inner.probe(),
    plan: (input) => inner.plan(input),
    dispatch: async (intent, ctx) => {
      const outcome = await inner.dispatch(intent, ctx);
      if (outcome.providerTaskId) evidence.providerTaskId = outcome.providerTaskId;
      return outcome;
    },
    stream: (runId) => inner.stream(runId),
    cancel: (runId) => inner.cancel(runId),
    reconcile: async (providerTaskId) => {
      const observation = await inner.reconcile(providerTaskId);
      if (observation.exitCode !== undefined) evidence.exitCode = observation.exitCode;
      return observation;
    },
    mapResult: (raw) => inner.mapResult(raw),
  };
}

/** Changed paths from git; the unverifiable sentinel when unavailable. */
export function changedPathsIn(workspace: string): string[] {
  const res = spawnSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return [UNVERIFIABLE_PATH];
  return res.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
    .map((p) => (p.includes(' -> ') ? (p.split(' -> ')[1] ?? p) : p));
}

/** Resolve an artifact id to a real file, contained inside the workspace. */
function resolveArtifact(workspace: string, artifactId: string): string | undefined {
  const root = path.resolve(workspace);
  const candidate = path.resolve(root, artifactId);
  // Containment: an artifact id must never escape the workspace.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return undefined;
  if (!existsSync(candidate)) return undefined;
  // Directories are not artifacts; reading one would throw later.
  return statSync(candidate).isFile() ? candidate : undefined;
}

/**
 * Verification context backed by the REAL workspace. Artifact ids resolve
 * as paths relative to the workspace; unresolved ids and unobserved values
 * fail closed rather than defaulting to success.
 */
export function workspaceCheckContext(input: {
  workspace: string;
  evidence: RunEvidence;
}): CheckContext {
  const { workspace, evidence } = input;
  return {
    artifactJson: (artifactId) => {
      const p = resolveArtifact(workspace, artifactId);
      if (!p) return undefined;
      try {
        return JSON.parse(readFileSync(p, 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    artifactSha256: (artifactId) => {
      const p = resolveArtifact(workspace, artifactId);
      if (!p) return undefined;
      return createHash('sha256').update(readFileSync(p)).digest('hex');
    },
    // One dispatch observes at most one process, so the check_ref does not
    // distinguish further here. An unobserved code stays undefined, which
    // makes `process.exit_code_equals` fail instead of passing.
    exitCode: () => evidence.exitCode ?? undefined,
    changedPaths: () => changedPathsIn(workspace),
    evidenceAgeDays: (evidenceId) => {
      const p = resolveArtifact(workspace, evidenceId);
      if (!p) return undefined;
      return (Date.now() - statSync(p).mtimeMs) / MS_PER_DAY;
    },
  };
}
