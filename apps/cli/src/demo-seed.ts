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
import { createHash } from 'node:crypto';
import { hashAction, hashScope, normalizeHostPath, randomNonce } from '@paos/core';
import {
  insertTask,
  insertWorkflowRun,
  insertDispatchIntent,
  insertApproval,
  insertRunContract,
  type TaskInsert,
  type WorkflowRunInsert,
  type DispatchIntentInsert,
  type ApprovalInsert,
} from '@paos/db';

/**
 * Frozen contracts for the approval-queue runs (ADR-005). The cockpit's approve
 * action resolves the contract by the hash in `workflow_runs.input_ref`; to make
 * the demo's approval path actually drive the CLI, each approval run carries a
 * real, schema-valid frozen contract whose hash matches its `input_ref`. These are
 * synthetic but well-formed (they validate against
 * paos://schemas/agent-task-contract/1.1.0) so the re-validation at approval time
 * passes and the cockpit can approve without falling back to a file.
 */
interface DemoContract {
  contract_version: string;
  task_id: string;
  workflow_run_id: string;
  step_id: string;
  objective: string;
  domain: string;
  workflow: { id: string; version: string };
  inputs: { workspace: string; artifact_refs: string[]; trust_labels: string[] };
  requirements: {
    required_capabilities: string[];
    scope_paths: string[];
    data_classification: string;
  };
  limits: {
    timeout_seconds: number;
    max_steps: number;
    max_tool_calls: number;
    max_cost: { amount: null; currency: null; source: string };
  };
  expected_output: { format: string; schema_id: string; required_artifacts: string[] };
  acceptance: Array<{ id: string; checker: string; args: Record<string, never> }>;
  policy: { risk_level: string; external_data_transfer: string; approval_ref: string };
  idempotency: { dispatch_key: string; delivery_semantics: string };
}

const DEMO_CONTRACTS: Record<string, DemoContract> = {
  'DEMO-WR-04': {
    contract_version: '1.1',
    task_id: 'DEMO-T-06',
    workflow_run_id: 'DEMO-WR-04',
    step_id: 'S-1',
    objective: 'release_funds',
    domain: 'investing',
    workflow: { id: 'wf-fin', version: '2.0.0' },
    inputs: { workspace: '/tmp/ws', artifact_refs: [], trust_labels: ['system_generated'] },
    requirements: { required_capabilities: ['credentials.use'], scope_paths: ['/tmp/ws'], data_classification: 'sensitive' },
    limits: { timeout_seconds: 300, max_steps: 10, max_tool_calls: 100, max_cost: { amount: null, currency: null, source: 'unknown' } },
    expected_output: { format: 'json', schema_id: 'paos://schemas/agent-result-contract/1.1.0', required_artifacts: ['result'] },
    acceptance: [{ id: 'ok', checker: 'verify.present', args: {} }],
    policy: { risk_level: 'R4', external_data_transfer: 'allow-with-approval', approval_ref: 'DEMO-A-01' },
    idempotency: { dispatch_key: 'DEMO-WR-04-S-1-key', delivery_semantics: 'at_least_once_with_reconciliation' },
  },
  'DEMO-WR-08': {
    contract_version: '1.1',
    task_id: 'DEMO-T-14',
    workflow_run_id: 'DEMO-WR-08',
    step_id: 'S-1',
    objective: 'merge_patch',
    domain: 'eng',
    workflow: { id: 'wf-cockpit', version: '1.0.0' },
    inputs: { workspace: '/tmp/ws', artifact_refs: [], trust_labels: ['system_generated'] },
    requirements: { required_capabilities: ['fs.write.workspace'], scope_paths: ['/tmp/ws'], data_classification: 'public' },
    limits: { timeout_seconds: 300, max_steps: 10, max_tool_calls: 100, max_cost: { amount: null, currency: null, source: 'unknown' } },
    expected_output: { format: 'json', schema_id: 'paos://schemas/agent-result-contract/1.1.0', required_artifacts: ['result'] },
    acceptance: [{ id: 'ok', checker: 'verify.present', args: {} }],
    policy: { risk_level: 'R1', external_data_transfer: 'allow-public-only', approval_ref: 'DEMO-A-02' },
    idempotency: { dispatch_key: 'DEMO-WR-08-S-1-key', delivery_semantics: 'at_least_once_with_reconciliation' },
  },
  'DEMO-WR-03': {
    contract_version: '1.1',
    task_id: 'DEMO-T-11',
    workflow_run_id: 'DEMO-WR-03',
    step_id: 'S-1',
    objective: 'retry_dispatch',
    domain: 'eng',
    workflow: { id: 'wf-cockpit', version: '1.0.0' },
    inputs: { workspace: '/tmp/ws', artifact_refs: [], trust_labels: ['system_generated'] },
    requirements: { required_capabilities: ['external.send'], scope_paths: ['/tmp/ws'], data_classification: 'public' },
    limits: { timeout_seconds: 300, max_steps: 10, max_tool_calls: 100, max_cost: { amount: null, currency: null, source: 'unknown' } },
    expected_output: { format: 'json', schema_id: 'paos://schemas/agent-result-contract/1.1.0', required_artifacts: ['result'] },
    acceptance: [{ id: 'ok', checker: 'verify.present', args: {} }],
    policy: { risk_level: 'R3', external_data_transfer: 'allow-public-only', approval_ref: 'DEMO-A-03' },
    idempotency: { dispatch_key: 'DEMO-WR-03-S-1-key', delivery_semantics: 'at_least_once_with_reconciliation' },
  },
};

/** sha256 hex of a JSON-serialised contract - must equal the `input_ref` digest. */
function hashContract(c: object): string {
  return createHash('sha256').update(JSON.stringify(c)).digest('hex');
}


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

// All three approval-queue contracts use the identical scope ['/tmp/ws']. The
// approval's resource-scope hash must be derived from the *normalized* scope,
// exactly as cmdApprove will normalize the frozen contract at approval time
// (normalizeContractPaths -> normalizeHostPath). Otherwise isSupersededByChange
// reports a spurious supersede on platforms where normalizeHostPath rewrites the
// path (e.g. /tmp -> %TEMP% on Windows), breaking the cockpit approve path.
const DEMO_SCOPE_HASH = hashScope(['/tmp/ws'].map((sp) => normalizeHostPath(sp)));

const APPROVALS: DemoRow<ApprovalInsert>[] = [
  // R4 - requires the contract to approve (the OD3-traced gate); deny is safe.
  // The action/scope hashes MUST equal the frozen contract's so the cockpit's
  // approve-by-hash path binds (see isSupersededByChange in @paos/core). The
  // contract for DEMO-WR-04 has objective 'release_funds' and scope ['/tmp/ws'].
  { ageMin: 90, base: { id: 'DEMO-A-01', workflowRunId: 'DEMO-WR-04', stepId: 'S-1', risk: 'R4', action: 'release_funds', actionHash: hashAction('release_funds'), resourceScopeHash: DEMO_SCOPE_HASH, nonce: randomNonce(), decision: 'pending' } },
  // Lower-risk, deny-safe.
  { ageMin: 280, base: { id: 'DEMO-A-02', workflowRunId: 'DEMO-WR-08', stepId: 'S-1', risk: 'R1', action: 'merge_patch', actionHash: hashAction('merge_patch'), resourceScopeHash: DEMO_SCOPE_HASH, decision: 'pending' } },
  // R3 review-style confirmation.
  { ageMin: 300, base: { id: 'DEMO-A-03', workflowRunId: 'DEMO-WR-03', stepId: 'S-1', risk: 'R3', action: 'retry_dispatch', actionHash: hashAction('retry_dispatch'), resourceScopeHash: DEMO_SCOPE_HASH, nonce: randomNonce(), decision: 'pending' } },
];

/** Seed a (already open, migrated) DB with the demo spread. */
export function seedDemoCockpit(db: DatabaseSync): void {
  for (const t of TASKS) insertTask(db, stamp(t.base, t.ageMin));
  for (const r of RUNS) insertWorkflowRun(db, stamp(r.base, r.ageMin));
  for (const d of DISPATCHES) insertDispatchIntent(db, stamp(d.base, d.ageMin));
  for (const a of APPROVALS) insertApproval(db, stamp(a.base, a.ageMin));

  // ADR-005: freeze a real contract for each approval-queue run so the cockpit's
  // approve action can resolve it by hash. The stored hash must equal the run's
  // `input_ref` digest, so we override the placeholder digest the runs were seeded
  // with and write the frozen copy. created_at mirrors the run's timestamp.
  for (const [runId, contract] of Object.entries(DEMO_CONTRACTS)) {
    const hash = hashContract(contract);
    const ts = db
      .prepare('SELECT created_at FROM workflow_runs WHERE id = ?')
      .get(runId) as { created_at: string } | undefined;
    const createdAt = ts?.created_at ?? new Date().toISOString();
    db.prepare('UPDATE workflow_runs SET input_ref = ? WHERE id = ?').run(`contract:${hash}`, runId);
    insertRunContract(db, {
      runId,
      contractHash: hash,
      contractJson: JSON.stringify(contract),
      createdAt,
    });
  }
}
