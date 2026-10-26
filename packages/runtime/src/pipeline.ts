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
  insertTask, updateTask, insertWorkflowRun, updateWorkflowRun,
  insertDispatchIntent, updateDispatchIntent, insertApproval,
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

export interface RunResult {
  taskId: string;
  runId: string;
  dispatchId: string;
  taskStatus: TaskStatus;
  dispatchState: string;
  runStatus: string;
  /** Present only when the Verifier produced a verdict. */
  verdict?: 'accepted' | 'rejected' | 'needs_human' | 'unknown_outcome';
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

export async function runContract(input: RunInput): Promise<RunResult> {
  const now = input.now ?? ((): string => new Date().toISOString());
  const { db, adapter, contract } = input;
  const ctx = input.checkContext ?? emptyContext();

  const taskId = contract.task_id || `task_${randomUUID()}`;
  const runId = contract.workflow_run_id || `wfr_${randomUUID()}`;
  const dispatchId = `dsp_${randomUUID()}`;
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

  let task: Task = {
    id: taskId,
    domain: contract.domain as Domain,
    title: contract.objective,
    nextAction: 'dispatch contract',
    doneCondition: contract.objective,
    status: 'inbox',
    risk: (verdict.allowed ? verdict.risk : 'R4') as RiskLevel,
    evidenceRefs: [],
    createdAt: t0,
    updatedAt: t0,
  };

  const persistTask = (): void => {
    updateTask(db, task.id, {
      status: task.status,
      risk: task.risk,
      terminal_reason: task.terminalReason ?? null,
      waiting_on: task.waitingOn ?? null,
      evidence_refs: JSON.stringify(task.evidenceRefs),
      verification_report_ref: task.verificationReportRef ?? null,
      accepted_at: task.acceptedAt ?? null,
      updated_at: now(),
    });
  };

  if (!verdict.allowed) {
    insertTask(db, {
      id: task.id, domain: task.domain, title: task.title,
      nextAction: task.nextAction, doneCondition: task.doneCondition,
      status: task.status, risk: task.risk, createdAt: t0, updatedAt: t0,
    });
    task = { ...task, terminalReason: verdict.reason };
    task = transition(task, 'rejected', now());
    persistTask();
    return {
      taskId, runId, dispatchId, taskStatus: task.status,
      dispatchState: 'pending', runStatus: 'failed', blocked: verdict.reason,
    };
  }

  // 3. Task intake: inbox -> triaged -> planned -> ready.
  insertTask(db, {
    id: task.id, domain: task.domain, title: task.title,
    nextAction: task.nextAction, doneCondition: task.doneCondition,
    status: task.status, risk: task.risk, createdAt: t0, updatedAt: t0,
  });
  insertWorkflowRun(db, {
    id: runId, workflowId: contract.workflow.id,
    workflowVersion: contract.workflow.version, domain: contract.domain,
    taskId, status: 'planned', codeVersion: 'v0.2', inputRef: `contract:${sha256(JSON.stringify(contract))}`,
    createdAt: t0, updatedAt: t0,
  });

  const advance = (to: TaskStatus): void => {
    task = transition(task, to, now());
    persistTask();
  };
  advance('triaged');
  advance('planned');
  advance('ready');
  advance('running');
  updateWorkflowRun(db, runId, { status: 'running', updated_at: now() });

  // 4. Risk gate: R3+ parks the run and records a one-time approval.
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
      taskId, runId, dispatchId, taskStatus: task.status,
      dispatchState: 'pending', runStatus: 'waiting_approval', approvalId,
    };
  }

  // 5. Outbox: the intent row is committed BEFORE any network call.
  let intent: DispatchIntent = {
    id: dispatchId, workflowRunId: runId, stepId: contract.step_id,
    adapterId: adapter.id, provider: adapter.provider,
    idempotencyKey: contract.policy.approval_ref ?? `${runId}-${contract.step_id}-${sha256(JSON.stringify(contract))}`,
    contractHash: sha256(JSON.stringify(contract)),
    state: 'pending', supportsServerIdempotency: health.supportsServerIdempotency,
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
    advance('blocked');
    updateWorkflowRun(db, runId, { status: 'unknown_outcome', updated_at: now() });
    return {
      taskId, runId, dispatchId, taskStatus: task.status,
      dispatchState: intent.state, runStatus: 'unknown_outcome',
    };
  }
  if (intent.state === 'rejected') {
    advance('failed');
    updateWorkflowRun(db, runId, { status: 'failed', updated_at: now() });
    return {
      taskId, runId, dispatchId, taskStatus: task.status,
      dispatchState: intent.state, runStatus: 'failed',
      blocked: outcome.error ?? 'dispatch rejected',
    };
  }

  // 6. Reconcile: map the provider status through the single mapper.
  const obs = await adapter.reconcile(outcome.providerTaskId ?? '');
  const runStatus = mapProviderStatus(
    adapter.provider as ProviderName,
    obs.providerStatus,
  );
  updateDispatchIntent(db, intent.id, { state: 'reconciled', resolved_at: now(), updated_at: now() });

  if (runStatus === 'failed') {
    advance('failed');
    updateWorkflowRun(db, runId, { status: 'failed', updated_at: now() });
    return {
      taskId, runId, dispatchId, taskStatus: task.status,
      dispatchState: 'reconciled', runStatus: 'failed',
    };
  }
  advance('review_required');
  updateWorkflowRun(db, runId, { status: runStatus, updated_at: now() });

  // 7. Three-layer verification. `accepted` is derived only here.
  const acceptance = contract.acceptance ?? [];
  if (acceptance.length === 0) {
    // Unverifiable contracts must never auto-accept: park for a human.
    task = { ...task, waitingOn: 'no_acceptance_criteria' };
    advance('blocked');
    updateWorkflowRun(db, runId, { status: 'paused', updated_at: now() });
    return {
      taskId, runId, dispatchId, taskStatus: task.status,
      dispatchState: 'reconciled', runStatus: 'paused', verdict: 'needs_human',
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
  const v = deriveVerdict(reports);

  // 8. Verdict -> terminal transition (T22 gate lives in acceptTask).
  if (v === 'accepted') {
    const evidenceRefs = contract.expected_output?.required_artifacts ?? [];
    task = acceptTask(task, {
      verificationReportRef: `vrep_${runId}`,
      evidenceRefs: evidenceRefs.length > 0 ? evidenceRefs : [`report_${runId}`],
      acceptedAt: now(),
    }, now());
    persistTask();
    updateWorkflowRun(db, runId, { status: 'succeeded', updated_at: now() });
  } else if (v === 'rejected') {
    task = { ...task, terminalReason: 'verification_rejected' };
    advance('failed');
    updateWorkflowRun(db, runId, { status: 'failed', updated_at: now() });
  } else {
    task = { ...task, waitingOn: 'human_review' };
    advance('blocked');
    updateWorkflowRun(db, runId, { status: 'paused', updated_at: now() });
  }

  return {
    taskId, runId, dispatchId, taskStatus: task.status,
    dispatchState: 'reconciled',
    runStatus: v === 'accepted' ? 'succeeded' : v === 'rejected' ? 'failed' : 'paused',
    verdict: v, reports,
  };
}
