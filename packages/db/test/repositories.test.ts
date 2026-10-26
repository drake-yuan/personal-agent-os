import { describe, expect, it, beforeEach } from 'vitest';
// Node 22.22 bundles SQLite 3.51.2; the documented escape hatch keeps the
// gate explicit (never silently bypassed) for the in-memory test DB.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { openDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import {
  insertTask, getTask, updateTask,
  insertWorkflowRun, updateWorkflowRun, getWorkflowRun,
  insertDispatchIntent, updateDispatchIntent, getDispatchIntent,
  insertApproval, updateApproval, pendingApprovals,
} from '../src/repositories.js';

let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
});

describe('task persistence', () => {
  it('round-trips a task and patches whitelisted columns', () => {
    insertTask(db, {
      id: 't1', domain: 'work', title: 'fix flaky test',
      nextAction: 'reproduce', doneCondition: 'green in CI',
      status: 'inbox', risk: 'R2', evidenceRefs: [],
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    const row = getTask(db, 't1');
    expect(row?.status).toBe('inbox');
    expect(row?.risk).toBe('R2');

    updateTask(db, 't1', { status: 'running', evidence_refs: '["a"]', updated_at: '2026-10-26T01:00:00.000Z' });
    expect(getTask(db, 't1')?.status).toBe('running');
    expect(getTask(db, 't1')?.evidence_refs).toBe('["a"]');
  });

  it('rejects a patch column outside the allowlist', () => {
    insertTask(db, {
      id: 't2', domain: 'work', title: 'x', nextAction: 'y',
      doneCondition: 'z', status: 'inbox', risk: 'R0',
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    expect(() => updateTask(db, 't2', { id: 'hacked' })).toThrow(/not patchable/);
  });

  it('rejects an empty patch', () => {
    expect(() => updateTask(db, 't1', {})).toThrow(/empty patch/);
  });
});

describe('workflow run + dispatch outbox persistence', () => {
  it('persists the run and moves the intent through outbox states', () => {
    // FK: workflow_runs.task_id -> tasks.id
    insertTask(db, {
      id: 't1', domain: 'work', title: 'x', nextAction: 'y',
      doneCondition: 'z', status: 'inbox', risk: 'R0',
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    insertWorkflowRun(db, {
      id: 'r1', workflowId: 'software-change', workflowVersion: '1.0.0',
      domain: 'work', taskId: 't1', status: 'planned', codeVersion: 'v0.2',
      inputRef: 'contract:abc', createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
    });
    updateWorkflowRun(db, 'r1', { status: 'running', updated_at: '2026-10-26T01:00:00.000Z' });
    expect(getWorkflowRun(db, 'r1')?.status).toBe('running');

    insertDispatchIntent(db, {
      id: 'd1', workflowRunId: 'r1', stepId: 'delegate', adapterId: 'demo-adapter',
      provider: 'demo', idempotencyKey: 'k1', contractHash: 'h1', state: 'pending',
      supportsServerIdempotency: true,
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    expect(getDispatchIntent(db, 'd1')?.state).toBe('pending');
    expect(getDispatchIntent(db, 'd1')?.supports_server_idempotency).toBe(1);

    updateDispatchIntent(db, 'd1', {
      state: 'unknown_outcome', attempt_count: 1,
      last_error: 'timeout', updated_at: '2026-10-26T02:00:00.000Z',
    });
    const intent = getDispatchIntent(db, 'd1');
    expect(intent?.state).toBe('unknown_outcome');
    expect(intent?.attempt_count).toBe(1);
    expect(intent?.last_error).toBe('timeout');
  });
});

describe('approval queue', () => {
  it('records a pending approval and resolves it once', () => {
    // FK: approvals.workflow_run_id -> workflow_runs.id -> tasks.id
    insertTask(db, {
      id: 't1', domain: 'work', title: 'x', nextAction: 'y',
      doneCondition: 'z', status: 'inbox', risk: 'R0',
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    insertWorkflowRun(db, {
      id: 'r1', workflowId: 'wf', workflowVersion: '1.0.0', domain: 'work',
      taskId: 't1', status: 'running', codeVersion: 'v0.2', inputRef: 'contract:abc',
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    insertApproval(db, {
      id: 'a1', workflowRunId: 'r1', stepId: 'delegate', risk: 'R4',
      action: 'send email', actionHash: 'h1', resourceScopeHash: 'h2',
      nonce: 'n1', decision: 'pending',
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    expect(pendingApprovals(db, 'r1')).toHaveLength(1);

    updateApproval(db, 'a1', {
      decision: 'approved', decided_by: 'human',
      decided_at: '2026-10-26T01:00:00.000Z',
      consumed_at: '2026-10-26T01:00:00.000Z',
      updated_at: '2026-10-26T01:00:00.000Z',
    });
    expect(pendingApprovals(db, 'r1')).toHaveLength(0);
  });
});
