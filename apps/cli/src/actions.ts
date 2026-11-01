/**
 * Pilot writes for the cockpit's mutation surface (ADR-004 P1-2).
 *
 * Design rule (from the OD3 trace and stack-review §5): the server never holds
 * the write lock and never imports `runContract` into its own event loop. Every
 * mutation is performed by spawning the *existing*, fully-tested CLI as a child
 * process. This keeps the server read-only and sidesteps F7 (synchronous SQLite
 * would otherwise block the HTTP event loop during a dispatch - OD2).
 *
 * Scope of this file is deliberately narrow:
 *   - `denyApproval` is the ONLY action wired today. It needs no contract (see
 *     packages/runtime/src/approvals.ts:143-159) and is the least-privileged
 *     decision, so exposing it through the cockpit is the safe first slice.
 *   - `approve` is intentionally NOT spawned here. Approving requires the
 *     contract file (approvals.ts:163-168); the contract-source-of-truth design
 *     (Option A, ADR-005) must land before the browser can drive it. The route
 *     returns a structured "run this in the terminal" instruction instead.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Conservative argv guard - spawn does not use a shell, but we keep the audit trail clean. */
const APPROVAL_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;

export interface SpawnResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  /** Override the CLI entry script (used by tests to inject a fake binary). */
  cliEntry?: string;
  /** Override the node binary (defaults to the running runtime). */
  nodeBin?: string;
}

/**
 * Resolve the path to the CLI entry script. Works in both dev (src/) and built
 * (dist/) layouts because it is computed relative to this module's own URL.
 */
export function resolveCliEntry(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
}

/**
 * Spawn the CLI as a child process and capture its output. Non-blocking: the
 * HTTP event loop stays free to serve other requests while the child runs, which
 * is exactly the OD2 guarantee this design relies on.
 */
export function spawnCli(args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  const nodeBin = opts.nodeBin ?? process.execPath;
  const cliEntry = opts.cliEntry ?? resolveCliEntry();
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(nodeBin, [cliEntry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c));
    child.stderr?.on('data', (c) => (stderr += c));
    child.on('error', (err) => {
      resolve({ ok: false, code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

export interface DenyApprovalInput {
  dataDir: string;
  approvalId: string;
  /** Who/what decided; the cockpit UI always records a non-human actor. */
  decidedBy?: string;
  cliEntry?: string;
}

/**
 * Record a denial for an approval by spawning `paos approve <id> --deny --by cockpit`.
 * The denial path needs no contract, so the cockpit can drive it directly while
 * still routing every mutation through the audited CLI. Returns the child's result.
 */
export async function denyApproval(input: DenyApprovalInput): Promise<SpawnResult> {
  if (!APPROVAL_ID_RE.test(input.approvalId)) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: `invalid approval id: ${JSON.stringify(input.approvalId)}`,
    };
  }
  if (!existsSync(path.join(input.dataDir, 'paos.db'))) {
    return { ok: false, code: -1, stdout: '', stderr: 'not initialized - run `paos init` first' };
  }
  const decidedBy = input.decidedBy ?? 'cockpit';
  // The spawned CLI defaults its data dir to a relative `data`, so we must pin it
  // to the server's dataDir explicitly - otherwise the child would approve against
  // the wrong (default) database.
  return spawnCli(
    ['approve', input.approvalId, '--deny', '--by', decidedBy, '--data-dir', input.dataDir],
    { cliEntry: input.cliEntry },
  );
}
