/**
 * Cockpit demo seed (P1-6, ADR-004).
 *
 * `paos cockpit --demo` builds a throwaway SQLite DB, seeds it with a
 * representative spread of the 14-state task machine, workflow runs, dispatch
 * intents and a pending-approval queue, then serves it read-only. The data is
 * synthetic and lives in a temp dir; the user's real `dataDir` is never touched.
 *
 * The intent is exactly what the review asked for: "so 14-state coverage is
 * visible during development". It also unblocks the Alt.1 -> accepted gate
 * (usage evidence) without requiring a live, initialised kernel DB.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  insertTask,
  insertWorkflowRun,
  insertDispatchIntent,
  insertApproval,
  type TaskInsert,
  type WorkflowRunInsert,
  type DispatchIntentInsert,
  type ApprovalInsert,
} from '@paos/db';

interface DemoRow<
  T extends TaskInsert | WorkflowRunInsert | DispatchIntentInsert | ApprovalInsert,
> {
  base: Omit<T, 'createdAt' | 'updatedAt'>;
  /** Minutes before "now" for this row's timestamps (older = larger). */
  ageMin: number;
}

function stamp<T extends Record<string, unknown>>(
  base: T,
  ageMin: number,
): T & { createdAt: string; updatedAt: string } {
  // Stable, decreasing timestamps so ORDER BY updated_at DESC is deterministic.
  const ts = new Date(Date.now() - ageMin * 60_000).toISOString();
  return { ...base, createdAt: ts, updatedAt: ts } as T & {
    createdAt: string;
    updatedAt: string;
  };
}

const TASKS: DemoRow<TaskInsert>[] = [
  { ageMin: 600, base: { id: 'DEMO-T-01', domain: 'eng', title: 'Inbox: triage inbound requests', nextAction: 'triage', doneCondition: 'classified', status: 'inbox', risk: 'R1', evidenceRefs: [] } },
  { ageMin: 580, base: { id: 'DEMO-T-02', domain: 'eng', title: 'Triage: scope the cockpit spike', nextAction: 'write spec', doneCondition: 'spec signed off', status: 'triaged', risk: 'R1', evidenceRefs: [] } },
  { ageMin: 540, base: { id: 'DEMO-T-03', domain: 'eng', title: 'Plan: read-only DB access path', nextAction: 'design', doneCondition: 'design merged', status: 'planned', risk: 'R2', evidenceRefs: [] } },
  { ageMin: 480, base: { id: 'DEMO-T-04', domain: 'ops', title: 'Ready: ship static board', nextAction: 'export html', doneCondition: 'board renders', status: 'ready', risk: 'R1', evidenceRefs: [] } },
  { ageMin: 120, base: { id: 'DEMO-T-05', domain: 'eng', title: 'Running: live polling client', nextAction: 'watch transitions', doneCondition: 'refreshes live', status: 'running', risk: 'R2', evidenceRefs: [] } },
  { ageMin: 90, base: { id: 'DEMO-T-06', domain: 'fin', title: 'Waiting approval: release funds', nextAction: 'human confirm', doneCondition: 'approved', status: 'waiting_approval', risk: 'R4', evidenceRefs: [] } },
  { ageMin: 200, base: { id: 'DEMO-T-07', domain: 'ops', title: 'Cancel requested: stale pipeline', nextAction: 'confirm cancel', doneCondition: 'cancelled', status: 'cancel_requested', risk: 'R2', evidenceRefs: [] } },
  { ageMin: 300, base: { id: 'DEMO-T-08', domain: 'eng', title: 'Review required: drift-check output', nextAction: 'review diff', doneCondition: 'reviewer ok', status: 'review_required', risk: 'R3', evidenceRefs: [] } },
  { ageMin: 360, base: { id: 'DEMO-T-09', domain: 'eng', title: 'Blocked: upstream API outage', nextAction: 'unblock dep', doneCondition: 'dependency restored', status: 'blocked', risk: 'R2', evidenceRefs: [] } },
  { ageMin: 420, base: { id: 'DEMO-T-10', domain: 'learn', title: 'Deferred: mobile layout', nextAction: 'revisit next q', doneCondition: 're-scoped', status: 'deferred', risk: 'R0', evidenceRefs: [] } },
  { ageMin: 260, base: { id: 'DEMO-T-11', domain: 'eng', title: 'Failed: broken migration', nextAction: 'fix + rerun', doneCondition: 'green CI', status: 'failed', risk: 'R3', evidenceRefs: [] } },
  { ageMin: 30, base: { id: 'DEMO-T-12', domain: 'eng', title: 'Done: auth baseline', nextAction: 'ship', doneCondition: 'shipped', status: 'done', risk: 'R2', evidenceRefs: ['demo-e1'] } },
  { ageMin: 400, base: { id: 'DEMO-T-13', domain: 'ops', title: 'Cancelled: abandoned experiment', nextAction: 'archive', doneCondition: 'archived', status: 'cancelled', risk: 'R1', evidenceRefs: [] } },
  { ageMin: 340, base: { id: 'DEMO-T-14', domain: 'fin', title: 'Rejected: unsafe auto-merge', nextAction: 'close', doneCondition: 'rejected', status: 'rejected', risk: 'R4', evidenceRefs: [] } },
];

const RUNS: DemoRow<WorkflowRunInsert>[] = [
  { ageMin: 30, base: { id: 'DEMO-WR-01', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-12', status: 'succeeded', codeVersion: 'a1b2c3', inputRef: 'contract:demo-a' } },
  { ageMin: 120, base: { id: 'DEMO-WR-02', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-05', status: 'running', codeVersion: 'a1b2c4', inputRef: 'contract:demo-b' } },
  { ageMin: 260, base: { id: 'DEMO-WR-03', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-11', status: 'failed', codeVersion: 'a1b2c5', inputRef: 'contract:demo-c' } },
  { ageMin: 90, base: { id: 'DEMO-WR-04', workflowId: 'wf-fin', workflowVersion: '2', domain: 'fin', taskId: 'DEMO-T-06', status: 'waiting_approval', codeVersion: 'a1b2c6', inputRef: 'contract:demo-d' } },
  { ageMin: 150, base: { id: 'DEMO-WR-05', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-08', status: 'unknown_outcome', codeVersion: 'a1b2c7', inputRef: 'contract:demo-e' } },
  { ageMin: 500, base: { id: 'DEMO-WR-06', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-13', status: 'reconciled', codeVersion: 'a1b2c8', inputRef: 'contract:demo-f' } },
  { ageMin: 220, base: { id: 'DEMO-WR-07', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-09', status: 'paused', codeVersion: 'a1b2c9', inputRef: 'contract:demo-g' } },
  { ageMin: 280, base: { id: 'DEMO-WR-08', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-14', status: 'partial', codeVersion: 'a1b2ca', inputRef: 'contract:demo-h' } },
  { ageMin: 540, base: { id: 'DEMO-WR-09', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-03', status: 'planned', codeVersion: 'a1b2cb', inputRef: 'contract:demo-i' } },
  { ageMin: 410, base: { id: 'DEMO-WR-10', workflowId: 'wf-cockpit', workflowVersion: '1', domain: 'eng', taskId: 'DEMO-T-13', status: 'cancelled', codeVersion: 'a1b2cc', inputRef: 'contract:demo-j' } },
];

const DISPATCHES: DemoRow<DispatchIntentInsert>[] = [
  { ageMin: 30, base: { id: 'DEMO-D-01', workflowRunId: 'DEMO-WR-01', stepId: 'S-1', adapterId: 'codex-adapter', provider: 'codex', idempotencyKey: 'k-01', contractHash: 'c-01', state: 'reconciled', supportsServerIdempotency: false } },
  { ageMin: 120, base: { id: 'DEMO-D-02', workflowRunId: 'DEMO-WR-02', stepId: 'S-1', adapterId: 'claude-adapter', provider: 'claude', idempotencyKey: 'k-02', contractHash: 'c-02', state: 'dispatching', supportsServerIdempotency: false } },
  { ageMin: 90, base: { id: 'DEMO-D-03', workflowRunId: 'DEMO-WR-04', stepId: 'S-1', adapterId: 'gemini-adapter', provider: 'gemini', idempotencyKey: 'k-03', contractHash: 'c-03', state: 'pending', supportsServerIdempotency: true } },
  { ageMin: 150, base: { id: 'DEMO-D-04', workflowRunId: 'DEMO-WR-05', stepId: 'S-1', adapterId: 'qwen-adapter', provider: 'qwen', idempotencyKey: 'k-04', contractHash: 'c-04', state: 'unknown_outcome', supportsServerIdempotency: false } },
  { ageMin: 260, base: { id: 'DEMO-D-05', workflowRunId: 'DEMO-WR-03', stepId: 'S-1', adapterId: 'codex-adapter', provider: 'codex', idempotencyKey: 'k-05', contractHash: 'c-05', state: 'rejected', supportsServerIdempotency: false } },
  { ageMin: 500, base: { id: 'DEMO-D-06', workflowRunId: 'DEMO-WR-06', stepId: 'S-1', adapterId: 'claude-adapter', provider: 'claude', idempotencyKey: 'k-06', contractHash: 'c-06', state: 'accepted', supportsServerIdempotency: false } },
];

const APPROVALS: DemoRow<ApprovalInsert>[] = [
  // R4 - requires the contract to approve (the OD3-traced gate); deny is safe.
  { ageMin: 90, base: { id: 'DEMO-A-01', workflowRunId: 'DEMO-WR-04', stepId: 'S-1', risk: 'R4', action: 'release_funds', actionHash: 'h-01', resourceScopeHash: 'r-01', decision: 'pending' } },
  // Lower-risk, deny-safe.
  { ageMin: 280, base: { id: 'DEMO-A-02', workflowRunId: 'DEMO-WR-08', stepId: 'S-1', risk: 'R1', action: 'merge_patch', actionHash: 'h-02', resourceScopeHash: 'r-02', decision: 'pending' } },
  // R3 review-style confirmation.
  { ageMin: 300, base: { id: 'DEMO-A-03', workflowRunId: 'DEMO-WR-03', stepId: 'S-1', risk: 'R3', action: 'retry_dispatch', actionHash: 'h-03', resourceScopeHash: 'r-03', decision: 'pending' } },
];

/** Seed a (already open, migrated) DB with the demo spread. */
export function seedDemoCockpit(db: DatabaseSync): void {
  for (const t of TASKS) insertTask(db, stamp(t.base, t.ageMin));
  for (const r of RUNS) insertWorkflowRun(db, stamp(r.base, r.ageMin));
  for (const d of DISPATCHES) insertDispatchIntent(db, stamp(d.base, d.ageMin));
  for (const a of APPROVALS) insertApproval(db, stamp(a.base, a.ageMin));
}
