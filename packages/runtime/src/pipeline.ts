/**
 * Core chain orchestration (design Sections 7 / 11 / 12 / 13):
 * contract -> policy -> task -> outbox dispatch -> observation ->
 * three-layer verification -> verdict -> done.
 *
 * Two invariants this module exists to enforce:
 *  1. An executor reporting `completed` is an OBSERVATION. `done` is only
 *     reachable through acceptTask(), which requires a verification report,
 *     evidence refs and accepted_at (task-machine guard T22).
 *  2. A dispatch timeout is `unknown_outcome`, never a silent `failed`.
 *
 * The chain is split in two so that a run parked on the human approval gate
 * can resume through the same dispatch path (see approvals.ts):
 *   runContract()      - intake, policy, risk gate
 *   runDispatchPhase() - outbox dispatch, observation, verification, verdict
 *
 * The adapter is typed structurally (not via @paos/adapters) to avoid a
 * runtime <-> adapters import cycle: adapters already import DispatchIntent
 * from this package.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transition, acceptTask, requiresHuman, hashAction, hashScope, randomNonce } from '@paos/core';
import type { Task, TaskStatus, Domain, RiskLevel } from '@paos/core';
import { evaluatePolicy } from '@paos/policy';
import {
  insertTask, getTask, updateTask, insertWorkflowRun, getWorkflowRun, updateWorkflowRun,
  insertDispatchIntent, getDispatchIntentByKey, updateDispatchIntent, insertApproval,
} from '@paos/db';
import { reduceDispatch } from './outbox.js';
import type { DispatchEvent } from './outbox.js';
import { mapProviderStatus, type ProviderName } from './status-map.js';
import { runLayer, deriveVerdict } from './verify.js';
import type { CheckContext, CheckerCall, Layer, VerificationReport } from './verify.js';
import type { DispatchIntent } from './types.js';

/** Structural adapter contract - satisfied by DemoAdapter and future CLI adapters. */
export interface DispatchAdapter {
  readonly id: string;
  readonly provider: string;
  probe(): Promise<{
    enforcedCapabilities: string[];
    unconfined: boolean;
    enforcedIsolation: string;
    supportsServerIdempotency: boolean;
  }>;
  plan(input: { contract: unknown; workspace: string }): Promise<unknown>;
  dispatch(
    intent: DispatchIntent,
    ctx: { plan: unknown },
  ): Promise<{ providerTaskId?: string; transport: string; error?: string }>;
  reconcile(providerTaskId: string): Promise<{
    providerTaskId: string;
    providerStatus: string;
    transport: string;
  }>;
}

export interface ContractV11 {
  contract_version: string;
  task_id: string;
  workflow_run_id: string;
  step_id: string;
  objective: string;
  domain: string;
  workflow: { id: string; version: string };
  inputs: {
    workspace: string;
    artifact_refs?: string[];
    trust_labels?: string[];
    context_refs?: string[];
  };
  requirements: {
    required_capabilities: string[];
    scope_paths: string[];
    data_classification: 'public' | 'personal' | 'sensitive' | 'secret';
  };
  expected_output?: {
    format: string;
    schema_id?: string;
    required_artifacts?: string[];
  };
  acceptance?: Array<{
    id: string;
    checker: string;
    checker_version?: number;
    /** Optional layer override; defaults to `product`. */
    layer?: Layer;
    args: Record<string, unknown>;
  }>;
  policy: { risk_level: string; external_data_transfer?: string; approval_ref?: string | null };
}

export type Verdict = 'accepted' | 'rejected' | 'needs_human' | 'unknown_outcome';

export interface RunResult {
  taskId: string;
  runId: string;
  dispatchId: string;
  taskStatus: TaskStatus;
  dispatchState: string;
  runStatus: string;
  /** Present only when the Verifier produced a verdict. */
  verdict?: Verdict;
  /** Policy refused the contract before dispatch. */
  blocked?: string;
  /** Human gate created - the run is parked until a decision is recorded. */
  approvalId?: string;
  reports?: VerificationReport[];
}

export interface RunInput {
  db: DatabaseSync;
  adapter: DispatchAdapter;
  contract: ContractV11;
  workspace: string;
  /** Evidence view used by the checkers. Omit to force a fail-closed verdict. */
  checkContext?: CheckContext;
  /** Structured action type driving the policy risk floor. */
  actionType?: 'read' | 'draft' | 'local-write' | 'external-send' | 'money' | 'delete' | 'trade';
  now?: () => string;
}

/** Fail-closed evidence view: no evidence means every check fails. */
function emptyContext(): CheckContext {
  return {
    artifactJson: () => undefined,
    artifactSha256: () => undefined,
    exitCode: () => undefined,
    changedPaths: () => [],
    evidenceAgeDays: () => undefined,
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Persist the in-memory Task onto its row. Shared by the chain and the gate. */
export function saveTask(db: DatabaseSync, task: Task, now: string): void {
  updateTask(db, task.id, {
    status: task.status,
    risk: task.risk,
    terminal_reason: task.terminalReason ?? null,
    waiting_on: task.waitingOn ?? null,
    evidence_refs: JSON.stringify(task.evidenceRefs),
    verification_report_ref: task.verificationReportRef ?? null,
    accepted_at: task.acceptedAt ?? null,
    updated_at: now,
  });
}

export interface DispatchPhaseInput {
  db: DatabaseSync;
  adapter: DispatchAdapter;
  contract: ContractV11;
  runId: string;
  /** Must already be in `running` (or resumed to it by the approval gate). */
  task: Task;
  workspace: string;
  checkContext?: CheckContext;
  now?: () => string;
}

export interface DispatchPhaseResult {
  task: Task;
  dispatchId: string;
  dispatchState: string;
  runStatus: string;
  verdict?: Verdict;
  reports?: VerificationReport[];
  blocked?: string;
}

/**
 * Outbox dispatch -> observation -> three-layer verification -> verdict.
 * Shared by a fresh run and by a run resumed from the approval gate.
 */
export async function runDispatchPhase(input: DispatchPhaseInput): Promise<DispatchPhaseResult> {
  const now = input.now ?? ((): string => new Date().toISOString());
  const { db, adapter, contract, runId } = input;
  const ctx = input.checkContext ?? emptyContext();
  let task = input.task;
  const dispatchId = `dsp_${randomUUID()}`;

  // Outbox: the intent row is committed BEFORE any network call.
  const probe = await adapter.probe();
  const idempotencyKey =
    contract.policy.approval_ref ?? `${runId}-${contract.step_id}-${sha256(JSON.stringify(contract))}`;

  // Idempotent re-dispatch: a contract carrying a stable idempotency key
  // (same run_id + step + contract hash) must reuse the existing intent rather
  // than crash on UNIQUE(dispatch_intents.idempotency_key) or double-insert.
  const existing = getDispatchIntentByKey(db, idempotencyKey);
  let intent: DispatchIntent;
  if (existing) {
    intent = {
      id: existing.id,
      workflowRunId: existing.workflow_run_id,
      stepId: existing.step_id,
      adapterId: existing.adapter_id,
      provider: existing.provider,
      idempotencyKey: existing.idempotency_key,
      contractHash: existing.contract_hash,
      state: existing.state as DispatchIntent['state'],
      supportsServerIdempotency: existing.supports_server_idempotency === 1,
      providerTaskId: existing.provider_task_id ?? undefined,
      attemptCount: existing.attempt_count,
      lastError: existing.last_error ?? undefined,
      dispatchedAt: existing.dispatched_at ?? undefined,
      resolvedAt: existing.resolved_at ?? undefined,
      createdAt: existing.created_at,
      updatedAt: existing.updated_at,
    };
  } else {
    intent = {
      id: dispatchId, workflowRunId: runId, stepId: contract.step_id,
      adapterId: adapter.id, provider: adapter.provider,
      idempotencyKey,
      contractHash: sha256(JSON.stringify(contract)),
      state: 'pending', supportsServerIdempotency: probe.supportsServerIdempotency,
      attemptCount: 0, createdAt: now(), updatedAt: now(),
    };
    insertDispatchIntent(db, {
      id: intent.id, workflowRunId: intent.workflowRunId, stepId: intent.stepId,
      adapterId: intent.adapterId, provider: intent.provider,
      idempotencyKey: intent.idempotencyKey, contractHash: intent.contractHash,
      state: intent.state,
      supportsServerIdempotency: intent.supportsServerIdempotency,
      createdAt: intent.createdAt, updatedAt: intent.updatedAt,
    });
  }

  // Idempotent re-dispatch: an intent already exists for this idempotency key,
  // meaning this exact dispatch was already attempted. Reuse the recorded outcome
  // rather than re-running the adapter or re-verifying (an outbox must never
  // double-execute on replay).
  if (existing) {
    const s = existing.state;
    const runStatus = s === 'rejected' ? 'failed'
      : s === 'unknown_outcome' ? 'unknown_outcome'
      : 'succeeded';
    return { task, dispatchId: existing.id, dispatchState: s, runStatus };
  }

  intent = reduceDispatch(intent, { type: 'dispatch', at: now() });
  updateDispatchIntent(db, intent.id, { state: intent.state, dispatched_at: now(), updated_at: now() });

  const plan = await adapter.plan({ contract, workspace: input.workspace });
  const outcome = await adapter.dispatch(intent, { plan });

  const event: DispatchEvent =
    outcome.transport === 'ok'
      ? { type: 'response-ok', providerTaskId: outcome.providerTaskId ?? '', at: now() }
      : outcome.transport === 'timeout'
        ? { type: 'timeout', at: now() }
        : { type: 'response-error', error: outcome.error ?? 'dispatch failed', at: now() };
  intent = reduceDispatch(intent, event);
  updateDispatchIntent(db, intent.id, {
    state: intent.state,
    provider_task_id: outcome.providerTaskId ?? null,
    attempt_count: intent.attemptCount,
    last_error: outcome.error ?? null,
    resolved_at: intent.state === 'unknown_outcome' ? null : now(),
    updated_at: now(),
  });

  if (intent.state === 'unknown_outcome') {
    // Honest: a timeout is not a failure. Park for human reconciliation.
    task = { ...task, waitingOn: 'dispatch_unknown_outcome' };
    task = transition(task, 'blocked', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'unknown_outcome', updated_at: now() });
    return { task, dispatchId, dispatchState: intent.state, runStatus: 'unknown_outcome' };
  }
  if (intent.state === 'rejected') {
    task = { ...task, terminalReason: outcome.error ?? 'dispatch rejected' };
    task = transition(task, 'failed', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'failed', updated_at: now() });
    return {
      task, dispatchId, dispatchState: intent.state, runStatus: 'failed',
      blocked: outcome.error ?? 'dispatch rejected',
    };
  }

  // Reconcile: map the provider status through the single mapper.
  const obs = await adapter.reconcile(outcome.providerTaskId ?? '');
  const runStatus = mapProviderStatus(adapter.provider as ProviderName, obs.providerStatus);
  updateDispatchIntent(db, intent.id, { state: 'reconciled', resolved_at: now(), updated_at: now() });

  if (runStatus === 'failed') {
    task = { ...task, terminalReason: 'provider_failed' };
    task = transition(task, 'failed', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'failed', updated_at: now() });
    return { task, dispatchId, dispatchState: 'reconciled', runStatus: 'failed' };
  }
  task = transition(task, 'review_required', now());
  saveTask(db, task, now());
  updateWorkflowRun(db, runId, { status: runStatus, updated_at: now() });

  // Three-layer verification. `accepted` is derived only here.
  const acceptance = contract.acceptance ?? [];
  if (acceptance.length === 0) {
    // Unverifiable contracts must never auto-accept: park for a human.
    task = { ...task, waitingOn: 'no_acceptance_criteria' };
    task = transition(task, 'blocked', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'paused', updated_at: now() });
    return {
      task, dispatchId, dispatchState: 'reconciled', runStatus: 'paused',
      verdict: 'needs_human',
    };
  }

  const byLayer = new Map<Layer, CheckerCall[]>();
  for (const a of acceptance) {
    const layer = a.layer ?? 'product';
    const calls = byLayer.get(layer) ?? [];
    calls.push({ id: a.id, checker: a.checker, checker_version: a.checker_version, args: a.args });
    byLayer.set(layer, calls);
  }
  const reports: VerificationReport[] = [];
  for (const [layer, calls] of byLayer) {
    reports.push(runLayer(layer, calls, ctx, runId));
  }
  const v: Verdict = deriveVerdict(reports);

  if (v === 'accepted') {
    const evidenceRefs = contract.expected_output?.required_artifacts ?? [];
    task = acceptTask(task, {
      verificationReportRef: `vrep_${runId}`,
      evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : [`report_${runId}`],
      acceptedAt: now(),
    }, now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'succeeded', updated_at: now() });
  } else if (v === 'rejected') {
    task = { ...task, terminalReason: 'verification_rejected' };
    task = transition(task, 'failed', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'failed', updated_at: now() });
  } else {
    task = { ...task, waitingOn: 'human_review' };
    task = transition(task, 'blocked', now());
    saveTask(db, task, now());
    updateWorkflowRun(db, runId, { status: 'paused', updated_at: now() });
  }

  return {
    task, dispatchId, dispatchState: 'reconciled',
    runStatus: v === 'accepted' ? 'succeeded' : v === 'rejected' ? 'failed' : 'paused',
    verdict: v, reports,
  };
}

export async function runContract(input: RunInput): Promise<RunResult> {
  const now = input.now ?? ((): string => new Date().toISOString());
  const { db, adapter, contract } = input;

  const taskId = contract.task_id || `task_${randomUUID()}`;
  const runId = contract.workflow_run_id || `wfr_${randomUUID()}`;
  const t0 = now();

  // 1. Probe: only ENFORCED capabilities may gate a decision.
  const health = await adapter.probe();

  // 2. Policy on structured inputs (never on free text alone).
  const verdict = evaluatePolicy({
    actionType: input.actionType ?? 'local-write',
    resourceScope: contract.requirements.scope_paths,
    dataClassification: contract.requirements.data_classification,
    enforcedCapabilities: health.enforcedCapabilities as never,
    unconfined: health.unconfined,
    description: contract.objective,
  });

  const risk = (verdict.allowed ? verdict.risk : 'R4') as RiskLevel;
  let task: Task = {
    id: taskId,
    domain: contract.domain as Domain,
    title: contract.objective,
    nextAction: 'dispatch contract',
    doneCondition: contract.objective,
    status: 'inbox',
    risk,
    evidenceRefs: [],
    createdAt: t0,
    updatedAt: t0,
  };

  // Idempotent dispatch: a replayed contract (same stable task_id) must not
  // crash on a UNIQUE constraint. If the task row already exists (e.g. a prior
  // dispatch of this same contract, or a retried CLI invocation against one
  // data-dir), reuse it instead of re-inserting and let the saveTask() UPDATEs
  // downstream carry the state forward.
  if (!getTask(db, task.id)) {
    insertTask(db, {
      id: task.id, domain: task.domain, title: task.title,
      nextAction: task.nextAction, doneCondition: task.doneCondition,
      status: task.status, risk: task.risk, createdAt: t0, updatedAt: t0,
    });
  }

  if (!verdict.allowed) {
    task = { ...task, terminalReason: verdict.reason };
    task = transition(task, 'rejected', now());
    saveTask(db, task, now());
    return {
      taskId, runId, dispatchId: 'none', taskStatus: task.status,
      dispatchState: 'pending', runStatus: 'failed', blocked: verdict.reason,
    };
  }

  if (!getWorkflowRun(db, runId)) {
    insertWorkflowRun(db, {
      id: runId, workflowId: contract.workflow.id,
      workflowVersion: contract.workflow.version, domain: contract.domain,
      taskId, status: 'planned', codeVersion: 'v0.2',
      inputRef: `contract:${sha256(JSON.stringify(contract))}`,
      createdAt: t0, updatedAt: t0,
    });
  }

  const advance = (to: TaskStatus): void => {
    task = transition(task, to, now());
    saveTask(db, task, now());
  };
  advance('triaged');
  advance('planned');
  advance('ready');
  advance('running');

  // 3. Risk gate: R3+ parks the run and records a one-time approval.
  if (requiresHuman(task.risk)) {
    advance('waiting_approval');
    const approvalId = `apr_${randomUUID()}`;
    insertApproval(db, {
      id: approvalId, workflowRunId: runId, stepId: contract.step_id,
      risk: task.risk, action: contract.objective,
      actionHash: hashAction(contract.objective),
      resourceScopeHash: hashScope(contract.requirements.scope_paths),
      nonce: randomNonce(), decision: 'pending',
      createdAt: now(), updatedAt: now(),
    });
    updateWorkflowRun(db, runId, { status: 'waiting_approval', updated_at: now() });
    return {
      taskId, runId, dispatchId: 'none', taskStatus: task.status,
      dispatchState: 'pending', runStatus: 'waiting_approval', approvalId,
    };
  }

  updateWorkflowRun(db, runId, { status: 'running', updated_at: now() });

  // 4. Dispatch phase (shared with a resumed, approved run).
  const phase = await runDispatchPhase({
    db, adapter, contract, runId, task,
    workspace: input.workspace, checkContext: input.checkContext, now: input.now,
  });
  return {
    taskId, runId, dispatchId: phase.dispatchId, taskStatus: phase.task.status,
    dispatchState: phase.dispatchState, runStatus: phase.runStatus,
    verdict: phase.verdict, reports: phase.reports, blocked: phase.blocked,
  };
}
