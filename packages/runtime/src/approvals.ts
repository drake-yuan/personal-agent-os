/**
 * Approval gate resolution (design Section 12.1 / 12.3).
 *
 * This is the exit that the risk gate in pipeline.ts creates: an R3/R4 run
 * parks in `waiting_approval` and can only leave through a recorded human
 * decision here.
 *
 * Enforced semantics (all inherited from @paos/core, never re-implemented):
 *  - an approval is decided once; re-deciding a decided approval is refused
 *  - R4 additionally requires an explicit human token
 *  - the approval binds the exact action + resource scope: if either changed,
 *    the approval is superseded and must be re-decided (replay defence)
 *  - consumption is once (consumed_at); an approval is consumed only when the
 *    execution it gates actually starts, never merely on approval
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  decide, attachToken, checkGate, consume, supersede, isSupersededByChange,
} from '@paos/core';
import type {
  Approval as CoreApproval, ApprovalDecision, RiskLevel, Task,
} from '@paos/core';
import { transition } from '@paos/core';
import { getApproval, updateApproval, getTask, getWorkflowRun, updateWorkflowRun } from '@paos/db';
import type { ApprovalRow, TaskRow } from '@paos/db';
import { saveTask, runDispatchPhase } from './pipeline.js';
import type { ContractV11, DispatchAdapter, Verdict } from './pipeline.js';
import type { CheckContext } from './verify.js';

export class ApprovalResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalResolveError';
  }
}

function toApproval(r: ApprovalRow): CoreApproval {
  return {
    id: r.id,
    workflowRunId: r.workflow_run_id,
    stepId: r.step_id,
    risk: r.risk as RiskLevel,
    action: r.action,
    actionHash: r.action_hash,
    resourceScopeHash: r.resource_scope_hash,
    nonce: r.nonce ?? undefined,
    token: r.token ?? undefined,
    decision: r.decision as ApprovalDecision,
    decidedBy: r.decided_by ?? undefined,
    decidedAt: r.decided_at ?? undefined,
    consumedAt: r.consumed_at ?? undefined,
    expiresAt: r.expires_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    domain: r.domain as Task['domain'],
    projectId: r.project_id ?? undefined,
    goalId: r.goal_id ?? undefined,
    title: r.title,
    nextAction: r.next_action,
    doneCondition: r.done_condition,
    status: r.status as Task['status'],
    risk: r.risk as RiskLevel,
    terminalReason: r.terminal_reason ?? undefined,
    waitingOn: r.waiting_on ?? undefined,
    estimateMin: r.estimate_min ?? undefined,
    actualMin: r.actual_min ?? undefined,
    deferredUntil: r.deferred_until ?? undefined,
    evidenceRefs: JSON.parse(r.evidence_refs) as string[],
    verificationReportRef: r.verification_report_ref ?? undefined,
    acceptedAt: r.accepted_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ResolveApprovalInput {
  db: DatabaseSync;
  approvalId: string;
  decision: 'approved' | 'denied';
  /** Named human decider - approvals are never anonymous. */
  decidedBy: string;
  /** Required for R4 (human-token-nonce). */
  token?: string;
  /**
   * The contract being authorised. Required to approve: the approval binds
   * action + scope, so the binding cannot be verified without it.
   */
  contract?: ContractV11;
  /** Supply adapter + workspace + evidence to resume the chain immediately. */
  adapter?: DispatchAdapter;
  workspace?: string;
  checkContext?: CheckContext;
  now?: () => string;
}

export interface ResolveApprovalResult {
  approvalId: string;
  decision: 'approved' | 'denied' | 'superseded';
  taskId: string;
  taskStatus: string;
  runStatus: string;
  /** Set when the approved run resumed and completed the chain. */
  verdict?: Verdict;
  dispatchId?: string;
}

export async function resolveApproval(
  input: ResolveApprovalInput,
): Promise<ResolveApprovalResult> {
  const now = input.now ?? ((): string => new Date().toISOString());
  const { db, approvalId } = input;

  const row = getApproval(db, approvalId);
  if (!row) throw new ApprovalResolveError(`approval ${approvalId} not found`);
  let approval = toApproval(row);
  if (approval.decision !== 'pending') {
    throw new ApprovalResolveError(
      `approval ${approvalId} is already ${approval.decision}; cannot re-decide`,
    );
  }
  if (!input.decidedBy) {
    throw new ApprovalResolveError('a named human decider is required');
  }

  const runRow = getWorkflowRun(db, row.workflow_run_id);
  const taskId = runRow?.task_id ?? '';
  if (!taskId) {
    throw new ApprovalResolveError(`no task bound to run ${row.workflow_run_id}`);
  }
  const taskRowForTask = getTask(db, taskId);
  if (!taskRowForTask) {
    throw new ApprovalResolveError(`task ${taskId} not found`);
  }
  let task = toTask(taskRowForTask);

  // ---------------------------------------------------------------- denied
  if (input.decision === 'denied') {
    approval = decide(approval, 'denied', input.decidedBy, now());
    updateApproval(db, approvalId, {
      decision: approval.decision,
      decided_by: approval.decidedBy ?? null,
      decided_at: approval.decidedAt ?? null,
      updated_at: now(),
    });
    task = { ...task, waitingOn: 'approval_denied' };
    task = transition(task, 'blocked', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, row.workflow_run_id, { status: 'paused', updated_at: now() });
    return {
      approvalId, decision: 'denied', taskId,
      taskStatus: task.status, runStatus: 'paused',
    };
  }

  // -------------------------------------------------------------- approved
  // The binding can only be verified against the contract it was issued for.
  if (!input.contract) {
    throw new ApprovalResolveError(
      'approving requires --contract: the approval binds action + scope and the ' +
      'binding cannot be verified without it',
    );
  }
  const { contract } = input;
  if (isSupersededByChange(approval, contract.objective, contract.requirements.scope_paths)) {
    approval = supersede(approval, now());
    updateApproval(db, approvalId, {
      decision: approval.decision, updated_at: now(),
    });
    // T15: a voided approval blocks the run rather than silently proceeding.
    task = { ...task, waitingOn: 'approval_superseded' };
    task = transition(task, 'blocked', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, row.workflow_run_id, { status: 'paused', updated_at: now() });
    return {
      approvalId, decision: 'superseded', taskId,
      taskStatus: task.status, runStatus: 'paused',
    };
  }

  approval = decide(approval, 'approved', input.decidedBy, now());
  if (approval.risk === 'R4') {
    if (!input.token) {
      throw new ApprovalResolveError('R4 approvals require an explicit --token');
    }
    approval = attachToken(approval, input.token, now());
  }
  // Gate check: expiry, nonce, named decider, R4 token, exact binding.
  checkGate(approval, {
    now: now(),
    action: contract.objective,
    resourceScope: contract.requirements.scope_paths,
  });

  updateApproval(db, approvalId, {
    decision: approval.decision,
    decided_by: approval.decidedBy ?? null,
    decided_at: approval.decidedAt ?? null,
    token: approval.token ?? null,
    updated_at: now(),
  });

  // T14: approved -> back to running.
  task = transition(task, 'running', now());
  saveTask(db, task, now());
  updateWorkflowRun(db, row.workflow_run_id, { status: 'running', updated_at: now() });

  // Without an adapter there is nothing to dispatch; the approval stays
  // spendable (approved, unconsumed) for a later resume.
  if (!input.adapter) {
    return {
      approvalId, decision: 'approved', taskId,
      taskStatus: task.status, runStatus: 'running',
    };
  }

  // Consume exactly once, at the moment the gated execution starts.
  approval = consume(approval, now());
  updateApproval(db, approvalId, {
    decision: approval.decision,
    consumed_at: approval.consumedAt ?? null,
    updated_at: now(),
  });

  const phase = await runDispatchPhase({
    db,
    adapter: input.adapter,
    contract,
    runId: row.workflow_run_id,
    task,
    workspace: input.workspace ?? contract.inputs.workspace,
    checkContext: input.checkContext,
    now: input.now,
  });
  return {
    approvalId, decision: 'approved', taskId,
    taskStatus: phase.task.status, runStatus: phase.runStatus,
    verdict: phase.verdict, dispatchId: phase.dispatchId,
  };
}
