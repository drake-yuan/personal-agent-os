/**
 * Pilot writes for the cockpit's mutation surface (ADR-004 P1-2 + ADR-005).
 *
 * Design rule (from the OD3 trace and stack-review §5): the server never holds
 * the write lock and never imports `runContract` into its own event loop. Every
 * mutation is performed by spawning the *existing*, fully-tested CLI as a child
 * process. This keeps the server read-only and sidesteps F7 (synchronous SQLite
 * would otherwise block the HTTP event loop during a dispatch - OD2).
 *
 * Wired actions:
 *   - `denyApproval` - needs no contract (approvals.ts:143-159), the
 *     least-privileged decision; the safe first slice of the mutation surface.
 *   - `approveApproval` (ADR-005) - resolves the frozen contract by hash and
 *     spawns `paos approve <id> --contract-hash <hash> --by cockpit`. The server
 *     never reads the contract body; the child re-validates it and performs the
 *     write, so the R3/R4 gate is preserved end-to-end. Runs frozen before
 *     ADR-005 have no `run_contracts` row and fall back to `--contract <file>`.
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

// A contract hash is a sha256 hex digest (lowercase a-f, 64 chars) but we stay
// permissive here and only reject obvious junk; the child re-validates.
const CONTRACT_HASH_RE = /^[a-fA-F0-9]{1,128}$/;

export interface ApproveApprovalInput {
  dataDir: string;
  approvalId: string;
  /** Frozen-contract hash (ADR-005); resolves the contract the CLI stored at run-creation. */
  contractHash: string;
  /** Who/what decided; the cockpit UI usually records a non-human actor. */
  decidedBy?: string;
  /** Required for R4 approvals (human-token-nonce). */
  token?: string;
  cliEntry?: string;
}

/**
 * Record an approval for an approval by spawning
 * `paos approve <id> --contract-hash <hash> --by cockpit [--token T]`. This is the
 * ADR-005 browser path: the server never reads or stores the contract body, it
 * only resolves the frozen copy by hash and delegates the mutation to the audited
 * CLI (read-only server, child-process write - OD2 / ADR-004).
 */
export async function approveApproval(input: ApproveApprovalInput): Promise<SpawnResult> {
  if (!APPROVAL_ID_RE.test(input.approvalId)) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: `invalid approval id: ${JSON.stringify(input.approvalId)}`,
    };
  }
  if (!CONTRACT_HASH_RE.test(input.contractHash)) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: `invalid contract hash: ${JSON.stringify(input.contractHash)}`,
    };
  }
  if (!existsSync(path.join(input.dataDir, 'paos.db'))) {
    return { ok: false, code: -1, stdout: '', stderr: 'not initialized - run `paos init` first' };
  }
  const decidedBy = input.decidedBy ?? 'cockpit';
  const args = [
    'approve', input.approvalId, '--contract-hash', input.contractHash,
    '--by', decidedBy, '--data-dir', input.dataDir,
  ];
  if (input.token) args.push('--token', input.token);
  return spawnCli(args, { cliEntry: input.cliEntry });
}
