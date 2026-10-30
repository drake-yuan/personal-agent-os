import { describe, expect, it } from 'vitest';
// Node 22.22 bundles SQLite 3.51.2; explicit escape hatch, never silent.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { openDatabase, migrate } from '@paos/db';
import { runContract } from '@paos/runtime';
import type { ContractV11, CheckContext, DispatchAdapter } from '@paos/runtime';
import {
  CodexAdapter, ClaudeCodeAdapter, GeminiAdapter, QwenCodeAdapter,
} from '@paos/adapters';
import type { ExecFn, ExecRequest } from '@paos/adapters';

/**
 * End-to-end hardening for G2 (real dispatch). The pipeline already has a
 * structural `fakeAdapter`, but it never exercises the real CLI adapter
 * classes (Codex/Claude/Gemini/Qwen). That gap is exactly why G2's "codex
 * really dispatched" proof was a one-off manual run, not a guarded invariant.
 *
 * Here we drive the REAL adapter instances through `runContract`, injecting a
 * fake `execFn` so the full spawn-shaped contract (objective on stdin, exit
 * code -> status mapping, timeout -> unknown_outcome) is exercised WITHOUT a
 * real vendor binary or network. This is reproducible in CI and proves every
 * registered adapter is a working implementation, not an empty shell.
 */
const OBJECTIVE = 'draft the change summary for the parser fix';

function fakeExec(opts: { exitCode?: number | null; timedOut?: boolean; stdout?: string; stderr?: string } = {}) {
  const calls: ExecRequest[] = [];
  const execFn: ExecFn = async (req: ExecRequest) => {
    calls.push(req);
    // A probe version check must always succeed so the adapter is treated as
    // installed; only the real dispatch (no `--version`) applies the simulated
    // outcome. Returning the same code for both would make the adapter look
    // uninstalled and the policy gate reject before dispatch.
    if (req.args.includes('--version')) {
      return { stdout: '1.0.0', stderr: '', exitCode: 0, timedOut: false, truncated: false };
    }
    return {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exitCode: opts.exitCode ?? 0,
      timedOut: opts.timedOut ?? false,
      truncated: false,
    };
  };
  return { execFn, calls };
}

function contract(over: Partial<ContractV11> = {}): ContractV11 {
  return {
    contract_version: '1.1',
    task_id: `task_${Math.random().toString(36).slice(2, 8)}`,
    workflow_run_id: `wfr_${Math.random().toString(36).slice(2, 8)}`,
    step_id: 'delegate',
    objective: OBJECTIVE,
    domain: 'work',
    workflow: { id: 'software-change', version: '1.0.0' },
    inputs: { workspace: process.cwd() },
    requirements: {
      // Every registered adapter enforces fs.read.workspace, so a read action
      // satisfies the policy floor for all four (read-only or wider).
      required_capabilities: ['fs.read.workspace'],
      scope_paths: ['src/'],
      data_classification: 'personal',
    },
    expected_output: { format: 'json', required_artifacts: ['change_summary'] },
    acceptance: [
      { id: 'exit-ok', checker: 'process.exit_code_equals', args: { check_ref: 'test', expected: 0 } },
    ],
    policy: { risk_level: 'R2', approval_ref: null },
    ...over,
  };
}

const passingContext: CheckContext = {
  artifactJson: () => ({ summary: 'x', risk_level: 'R2' }),
  artifactSha256: () => 'abc',
  exitCode: (ref) => (ref === 'test' ? 0 : undefined),
  changedPaths: () => ['src/app.ts'],
  evidenceAgeDays: () => 0,
};

const adapterCases = [
  { name: 'CodexAdapter', make: (f: ExecFn) => new CodexAdapter({ execFn: f, executable: process.execPath }), provider: 'codex' },
  { name: 'ClaudeCodeAdapter', make: (f: ExecFn) => new ClaudeCodeAdapter({ execFn: f, executable: process.execPath }), provider: 'claude-code' },
  { name: 'GeminiAdapter', make: (f: ExecFn) => new GeminiAdapter({ execFn: f, executable: process.execPath }), provider: 'gemini' },
  { name: 'QwenCodeAdapter', make: (f: ExecFn) => new QwenCodeAdapter({ execFn: f, executable: process.execPath }), provider: 'qwen-code' },
];

describe.each(adapterCases)('$name: real adapter driven through runContract', (c) => {
  it('reaches done only through the Verifier, objective on stdin (G2 hardening)', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const { execFn, calls } = fakeExec({ exitCode: 0 });
    const adapter = c.make(execFn);
    const r = await runContract({
      db,
      adapter: adapter as unknown as DispatchAdapter,
      contract: contract(),
      workspace: process.cwd(),
      checkContext: passingContext,
      actionType: 'read',
    });
    expect(r.verdict).toBe('accepted');
    expect(r.taskStatus).toBe('done');
    expect(r.runStatus).toBe('succeeded');
    expect(r.dispatchState).toBe('reconciled');

    // G2 empirical invariant: a real provider task id is recorded in the outbox.
    const rows = db.prepare('SELECT provider_task_id FROM dispatch_intents WHERE provider = ?')
      .all(c.provider) as unknown as Array<{ provider_task_id: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].provider_task_id).toMatch(new RegExp(`^${c.provider}-`));

    // Security invariant: the untrusted objective travels over stdin, never argv.
    const dispatchCall = calls[calls.length - 1]!;
    expect(dispatchCall.stdin).toContain(OBJECTIVE);
    expect(dispatchCall.args.join(' ')).not.toContain('parser fix');
    db.close();
  });

  it('maps a non-zero exit to failed across the full chain', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const { execFn } = fakeExec({ exitCode: 3, stderr: 'boom' });
    const adapter = c.make(execFn);
    const r = await runContract({
      db, adapter: adapter as unknown as DispatchAdapter, contract: contract(),
      workspace: process.cwd(), checkContext: passingContext, actionType: 'read',
    });
    expect(r.dispatchState).toBe('reconciled');
    expect(r.runStatus).toBe('failed');
    expect(r.taskStatus).toBe('failed');
    db.close();
  });

  it('maps a timeout to unknown_outcome, never a silent failure', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const { execFn } = fakeExec({ exitCode: null, timedOut: true });
    const adapter = c.make(execFn);
    const r = await runContract({
      db, adapter: adapter as unknown as DispatchAdapter, contract: contract(),
      workspace: process.cwd(), checkContext: passingContext, actionType: 'read',
    });
    expect(r.dispatchState).toBe('unknown_outcome');
    expect(r.runStatus).toBe('unknown_outcome');
    expect(r.taskStatus).toBe('blocked');
    expect(r.verdict).toBeUndefined();
    db.close();
  });
});
