import { describe, expect, it } from 'vitest';
// Node 22.22 bundles SQLite 3.51.2; explicit escape hatch, never silent.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { openDatabase, migrate } from '@paos/db';
import { runContract } from '../src/pipeline.js';
import type { ContractV11, DispatchAdapter } from '../src/pipeline.js';
import type { CheckContext } from '../src/verify.js';

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

/**
 * Minimal structural adapter. Deliberately NOT DemoAdapter: the pipeline
 * must depend only on the structural contract, never on a concrete package.
 */
function fakeAdapter(over: {
  transport?: string;
  providerStatus?: string;
} = {}): DispatchAdapter {
  return {
    id: 'fake-adapter',
    provider: 'demo',
    async probe() {
      return {
        enforcedCapabilities: ['fs.read.workspace', 'fs.write.workspace'],
        unconfined: false,
        enforcedIsolation: 'workspace-fs',
        supportsServerIdempotency: true,
      };
    },
    async plan() {
      return { provider: 'demo', command: ['fake'], cwd: '/ws', env: {}, estimatedMaxSilentMs: 1000 };
    },
    async dispatch() {
      return over.transport === 'timeout'
        ? { transport: 'timeout', error: 'timed out' }
        : over.transport === 'error'
          ? { transport: 'protocol_error', error: 'bad protocol' }
          : { transport: 'ok', providerTaskId: 'pt-1' };
    },
    async reconcile(providerTaskId: string) {
      return {
        providerTaskId,
        providerStatus: over.providerStatus ?? 'completed',
        transport: 'ok',
      };
    },
  };
}

function contract(over: Partial<ContractV11> = {}): ContractV11 {
  return {
    contract_version: '1.1',
    task_id: `task_${Math.random().toString(36).slice(2, 8)}`,
    workflow_run_id: `wfr_${Math.random().toString(36).slice(2, 8)}`,
    step_id: 'delegate',
    // "draft" keeps the NL risk classifier at R1 so the structured R2 floor
    // wins; unknown objectives are deny-first R4 and would gate on a human.
    objective: 'draft the change summary',
    domain: 'work',
    workflow: { id: 'software-change', version: '1.0.0' },
    inputs: { workspace: '/ws' },
    requirements: {
      required_capabilities: ['fs.write.workspace'],
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

/** Evidence view that satisfies the acceptance check under test. */
const passingContext: CheckContext = {
  artifactJson: () => ({ summary: 'x', risk_level: 'R2' }),
  artifactSha256: () => 'abc',
  exitCode: (ref) => (ref === 'test' ? 0 : undefined),
  changedPaths: () => ['src/app.ts'],
  evidenceAgeDays: () => 0,
};

describe('core chain: contract -> dispatch -> verification -> done', () => {
  it('reaches done only through the Verifier (happy path)', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter(),
      contract: contract(),
      workspace: '/ws',
      checkContext: passingContext,
    });
    expect(r.verdict).toBe('accepted');
    expect(r.taskStatus).toBe('done');
    expect(r.runStatus).toBe('succeeded');
    expect(r.dispatchState).toBe('reconciled');
    db.close();
  });

  it('a dispatch timeout is unknown_outcome, never a silent failure', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter({ transport: 'timeout' }),
      contract: contract(),
      workspace: '/ws',
      checkContext: passingContext,
    });
    expect(r.dispatchState).toBe('unknown_outcome');
    expect(r.runStatus).toBe('unknown_outcome');
    expect(r.taskStatus).toBe('blocked');
    expect(r.verdict).toBeUndefined();
    db.close();
  });

  it('provider failure maps to failed, not done', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter({ providerStatus: 'failed' }),
      contract: contract(),
      workspace: '/ws',
      checkContext: passingContext,
    });
    expect(r.runStatus).toBe('failed');
    expect(r.taskStatus).toBe('failed');
    db.close();
  });

  it('fail-closed: no evidence means verification rejects', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter(),
      contract: contract(),
      workspace: '/ws',
      // no checkContext -> empty (fail-closed) evidence view
    });
    expect(r.verdict).toBe('rejected');
    expect(r.taskStatus).toBe('failed');
    db.close();
  });

  it('an unverifiable contract (no acceptance) is parked, never auto-accepted', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter(),
      contract: contract({ acceptance: [] }),
      workspace: '/ws',
      checkContext: passingContext,
    });
    expect(r.verdict).toBe('needs_human');
    expect(r.taskStatus).toBe('blocked');
    db.close();
  });

  it('R3+ work parks on a human approval instead of dispatching', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter(),
      // "send" is an R4 keyword -> NL risk wins over the structured floor
      contract: contract({ objective: 'send the summary externally' }),
      workspace: '/ws',
      checkContext: passingContext,
    });
    expect(r.taskStatus).toBe('waiting_approval');
    expect(r.runStatus).toBe('waiting_approval');
    expect(r.approvalId).toBeTruthy();
    expect(r.verdict).toBeUndefined();
    db.close();
  });

  it('policy denial never dispatches', async () => {
    const db = freshDb();
    const r = await runContract({
      db,
      adapter: fakeAdapter(),
      contract: contract(),
      workspace: '/ws',
      actionType: 'external-send', // enforces external.send, which the adapter lacks
      checkContext: passingContext,
    });
    expect(r.blocked).toContain('external.send');
    expect(r.taskStatus).toBe('rejected');
    db.close();
  });
});
