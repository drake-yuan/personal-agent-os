import { describe, expect, it } from 'vitest';
// Node 22.22 bundles SQLite 3.51.2; explicit escape hatch, never silent.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { openDatabase, migrate, getTask, getApproval } from '@paos/db';
import { runContract } from '../src/pipeline.js';
import { resolveApproval as resolve } from '../src/approvals.js';
import type { ContractV11, DispatchAdapter } from '../src/pipeline.js';
import type { CheckContext } from '../src/verify.js';

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function fakeAdapter(): DispatchAdapter {
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
      return { transport: 'ok', providerTaskId: 'pt-1' };
    },
    async reconcile(providerTaskId: string) {
      return { providerTaskId, providerStatus: 'completed', transport: 'ok' };
    },
  };
}

/** An R4 objective parks the run on the human gate. */
function gatedContract(over: Partial<ContractV11> = {}): ContractV11 {
  return {
    contract_version: '1.1',
    task_id: `task_${Math.random().toString(36).slice(2, 8)}`,
    workflow_run_id: `wfr_${Math.random().toString(36).slice(2, 8)}`,
    step_id: 'delegate',
    objective: 'send the summary externally',
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
    policy: { risk_level: 'R4', approval_ref: null },
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

async function parkedRun(db: ReturnType<typeof freshDb>, contract = gatedContract()) {
  const r = await runContract({
    db, adapter: fakeAdapter(), contract, workspace: '/ws', checkContext: passingContext,
  });
  if (!r.approvalId) throw new Error('expected the run to park on the gate');
  return { contract, approvalId: r.approvalId, taskId: r.taskId };
}

describe('approval gate resolution', () => {
  it('an approved R4 run (with token) resumes and completes the chain', async () => {
    const db = freshDb();
    const { contract, approvalId, taskId } = await parkedRun(db);
    expect(getTask(db, taskId)?.status).toBe('waiting_approval');

    const r = await resolve({
      db, approvalId, decision: 'approved', decidedBy: 'drake',
      token: 'human-confirmed', contract, adapter: fakeAdapter(),
      workspace: '/ws', checkContext: passingContext,
    });
    expect(r.decision).toBe('approved');
    expect(r.taskStatus).toBe('done');
    expect(r.verdict).toBe('accepted');
    // consumed exactly once
    expect(getApproval(db, approvalId)?.consumed_at).toBeTruthy();
    db.close();
  });

  it('R4 cannot be approved without an explicit token', async () => {
    const db = freshDb();
    const { contract, approvalId } = await parkedRun(db);
    await expect(resolve({
      db, approvalId, decision: 'approved', decidedBy: 'drake', contract,
    })).rejects.toThrow(/--token/);
    db.close();
  });

  it('approving requires the contract (binding cannot be verified without it)', async () => {
    const db = freshDb();
    const { approvalId } = await parkedRun(db);
    await expect(resolve({
      db, approvalId, decision: 'approved', decidedBy: 'drake', token: 't',
    })).rejects.toThrow(/--contract/);
    db.close();
  });

  it('a changed action/scope supersedes the approval and blocks the run', async () => {
    const db = freshDb();
    const { contract, approvalId, taskId } = await parkedRun(db);
    const r = await resolve({
      db,
      approvalId,
      decision: 'approved',
      decidedBy: 'drake',
      token: 'human-confirmed',
      // different objective -> the bound action no longer matches
      contract: { ...contract, objective: 'send something else entirely' },
    });
    expect(r.decision).toBe('superseded');
    expect(r.taskStatus).toBe('blocked');
    expect(getTask(db, taskId)?.status).toBe('blocked');
    db.close();
  });

  it('denial parks the run and never dispatches', async () => {
    const db = freshDb();
    const { contract, approvalId, taskId } = await parkedRun(db);
    const r = await resolve({
      db, approvalId, decision: 'denied', decidedBy: 'drake', contract,
    });
    expect(r.decision).toBe('denied');
    expect(r.taskStatus).toBe('blocked');
    expect(getTask(db, taskId)?.status).toBe('blocked');
    db.close();
  });

  it('an approval cannot be re-decided (replay defence)', async () => {
    const db = freshDb();
    const { contract, approvalId } = await parkedRun(db);
    await resolve({
      db, approvalId, decision: 'approved', decidedBy: 'drake',
      token: 'human-confirmed', contract, adapter: fakeAdapter(),
      workspace: '/ws', checkContext: passingContext,
    });
    await expect(resolve({
      db, approvalId, decision: 'approved', decidedBy: 'drake',
      token: 'again', contract,
    })).rejects.toThrow(/already/);
    db.close();
  });

  it('approving without an adapter records the decision but does not consume it', async () => {
    const db = freshDb();
    const { contract, approvalId, taskId } = await parkedRun(db);
    const r = await resolve({
      db, approvalId, decision: 'approved', decidedBy: 'drake',
      token: 'human-confirmed', contract,
    });
    expect(r.taskStatus).toBe('running');
    expect(getApproval(db, approvalId)?.consumed_at).toBeNull();
    expect(getTask(db, taskId)?.status).toBe('running');
    db.close();
  });
});
