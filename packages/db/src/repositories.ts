/**
 * Persistence for the core chain: tasks, workflow runs, dispatch intents,
 * approvals (design Sections 7 / 11 / 12).
 *
 * The DB is the single source of truth for state. Row types mirror
 * migrations/0001_init_v2.sql exactly. UPDATE statements are assembled
 * from a per-table column allowlist, so no caller-supplied identifier
 * ever reaches the SQL text - values are always bound parameters.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface TaskRow {
  id: string;
  domain: string;
  project_id: string | null;
  goal_id: string | null;
  title: string;
  next_action: string;
  done_condition: string;
  status: string;
  risk: string;
  terminal_reason: string | null;
  waiting_on: string | null;
  estimate_min: number | null;
  actual_min: number | null;
  deferred_until: string | null;
  evidence_refs: string;
  verification_report_ref: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  workflow_version: string;
  domain: string;
  task_id: string | null;
  status: string;
  terminal_reason: string | null;
  code_version: string;
  worker_id: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  input_ref: string;
  created_at: string;
  updated_at: string;
}

export interface DispatchIntentRow {
  id: string;
  workflow_run_id: string;
  step_id: string;
  adapter_id: string;
  provider: string;
  idempotency_key: string;
  contract_hash: string;
  state: string;
  supports_server_idempotency: number;
  provider_task_id: string | null;
  attempt_count: number;
  last_error: string | null;
  dispatched_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  workflow_run_id: string;
  step_id: string;
  risk: string;
  action: string;
  action_hash: string;
  resource_scope_hash: string;
  nonce: string | null;
  token: string | null;
  decision: string;
  decided_by: string | null;
  decided_at: string | null;
  consumed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns a caller may patch, per table (injection allowlist). */
const TASK_PATCHABLE = [
  'project_id', 'goal_id', 'title', 'next_action', 'done_condition', 'status',
  'risk', 'terminal_reason', 'waiting_on', 'estimate_min', 'actual_min',
  'deferred_until', 'evidence_refs', 'verification_report_ref', 'accepted_at',
  'updated_at',
] as const;

const RUN_PATCHABLE = [
  'task_id', 'status', 'terminal_reason', 'worker_id', 'lease_until',
  'heartbeat_at', 'updated_at',
] as const;

const DISPATCH_PATCHABLE = [
  'state', 'provider_task_id', 'attempt_count', 'last_error', 'dispatched_at',
  'resolved_at', 'updated_at',
] as const;

const APPROVAL_PATCHABLE = [
  'decision', 'decided_by', 'decided_at', 'consumed_at', 'expires_at',
  'token', 'updated_at',
] as const;

type Patch = Record<string, string | number | null>;

/**
 * Build `SET a = ?, b = ?` from an allowlist. Unknown keys are rejected
 * rather than silently dropped - a typo must fail loudly at dev time.
 */
function setClause(
  patch: Patch,
  allowlist: readonly string[],
): { sql: string; values: Array<string | number | null> } {
  const keys = Object.keys(patch);
  const rejected = keys.filter((k) => !(allowlist as readonly string[]).includes(k));
  if (rejected.length > 0) {
    throw new Error(`not patchable: ${rejected.join(', ')}`);
  }
  if (keys.length === 0) throw new Error('empty patch');
  return {
    sql: keys.map((k) => `${k} = ?`).join(', '),
    values: keys.map((k) => patch[k] ?? null),
  };
}

function updateById(
  db: DatabaseSync,
  table: string,
  id: string,
  patch: Patch,
  allowlist: readonly string[],
): void {
  const { sql, values } = setClause(patch, allowlist);
  db.prepare(`UPDATE ${table} SET ${sql} WHERE id = ?`).run(...values, id);
}

// ---------------------------------------------------------------- tasks

export interface TaskInsert {
  id: string;
  domain: string;
  title: string;
  nextAction: string;
  doneCondition: string;
  status: string;
  risk: string;
  evidenceRefs?: string[];
  createdAt: string;
  updatedAt: string;
}

export function insertTask(db: DatabaseSync, t: TaskInsert): void {
  db.prepare(
    `INSERT INTO tasks (id, domain, title, next_action, done_condition, status,
       risk, evidence_refs, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id, t.domain, t.title, t.nextAction, t.doneCondition, t.status, t.risk,
    JSON.stringify(t.evidenceRefs ?? []), t.createdAt, t.updatedAt,
  );
}

export function getTask(db: DatabaseSync, id: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
}

export function updateTask(db: DatabaseSync, id: string, patch: Patch): void {
  updateById(db, 'tasks', id, patch, TASK_PATCHABLE);
}

// --------------------------------------------------------- workflow runs

export interface WorkflowRunInsert {
  id: string;
  workflowId: string;
  workflowVersion: string;
  domain: string;
  taskId: string;
  status: string;
  codeVersion: string;
  inputRef: string;
  createdAt: string;
  updatedAt: string;
}

export function insertWorkflowRun(db: DatabaseSync, r: WorkflowRunInsert): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, workflow_version, domain, task_id,
       status, code_version, input_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id, r.workflowId, r.workflowVersion, r.domain, r.taskId, r.status,
    r.codeVersion, r.inputRef, r.createdAt, r.updatedAt,
  );
}

export function getWorkflowRun(db: DatabaseSync, id: string): WorkflowRunRow | undefined {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined;
}

export function updateWorkflowRun(db: DatabaseSync, id: string, patch: Patch): void {
  updateById(db, 'workflow_runs', id, patch, RUN_PATCHABLE);
}

// ------------------------------------------------------ dispatch intents

export interface DispatchIntentInsert {
  id: string;
  workflowRunId: string;
  stepId: string;
  adapterId: string;
  provider: string;
  idempotencyKey: string;
  contractHash: string;
  state: string;
  supportsServerIdempotency: boolean;
  createdAt: string;
  updatedAt: string;
}

export function insertDispatchIntent(db: DatabaseSync, d: DispatchIntentInsert): void {
  db.prepare(
    `INSERT INTO dispatch_intents (id, workflow_run_id, step_id, adapter_id, provider,
       idempotency_key, contract_hash, state, supports_server_idempotency,
       attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    d.id, d.workflowRunId, d.stepId, d.adapterId, d.provider, d.idempotencyKey,
    d.contractHash, d.state, d.supportsServerIdempotency ? 1 : 0, d.createdAt, d.updatedAt,
  );
}

export function getDispatchIntent(db: DatabaseSync, id: string): DispatchIntentRow | undefined {
  return db.prepare('SELECT * FROM dispatch_intents WHERE id = ?').get(id) as DispatchIntentRow | undefined;
}

export function updateDispatchIntent(db: DatabaseSync, id: string, patch: Patch): void {
  updateById(db, 'dispatch_intents', id, patch, DISPATCH_PATCHABLE);
}

// ------------------------------------------------------------- approvals

export interface ApprovalInsert {
  id: string;
  workflowRunId: string;
  stepId: string;
  risk: string;
  action: string;
  actionHash: string;
  resourceScopeHash: string;
  nonce?: string;
  token?: string;
  decision: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function insertApproval(db: DatabaseSync, a: ApprovalInsert): void {
  db.prepare(
    `INSERT INTO approvals (id, workflow_run_id, step_id, risk, action, action_hash,
       resource_scope_hash, nonce, token, decision, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id, a.workflowRunId, a.stepId, a.risk, a.action, a.actionHash,
    a.resourceScopeHash, a.nonce ?? null, a.token ?? null, a.decision,
    a.expiresAt ?? null, a.createdAt, a.updatedAt,
  );
}

export function getApproval(db: DatabaseSync, id: string): ApprovalRow | undefined {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
}

export function updateApproval(db: DatabaseSync, id: string, patch: Patch): void {
  updateById(db, 'approvals', id, patch, APPROVAL_PATCHABLE);
}

/** Pending approvals for a run - the human queue. */
export function pendingApprovals(db: DatabaseSync, runId?: string): ApprovalRow[] {
  const q = runId
    ? 'SELECT * FROM approvals WHERE decision = ? AND workflow_run_id = ?'
    : 'SELECT * FROM approvals WHERE decision = ?';
  const args = runId ? ['pending', runId] : ['pending'];
  return db.prepare(q).all(...args) as unknown as ApprovalRow[];
}
