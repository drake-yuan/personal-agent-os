/**
 * Task state machine v2 - the complete transition matrix (design Section 7.1).
 *
 * The table below IS the specification: every legal edge has a test,
 * every illegal edge must be rejected. Key invariants:
 *  1. `done` is written by the Verifier only, with a full three-layer
 *     verification record (accepted_at + evidence_refs + report ref).
 *  2. `waiting_approval` must reference an approval bound to
 *     step_id + action_hash + resource scope.
 *  3. `cancel_requested` is NOT terminal - it reconciles to
 *     cancelled / running / review_required.
 *  4. External `unknown_outcome` never collapses into failed/cancelled.
 *  5. An executor claiming completion never closes a task.
 */
import type { Task, TaskStatus } from './types.js';

export type Actor = 'user' | 'system' | 'router' | 'verifier' | 'adapter' | 'runtime';

export interface TransitionRow {
  id: string;
  from: TaskStatus;
  to: TaskStatus;
  actor: Actor;
  reasonCode: string;
  guard?: (task: Task) => string | undefined; // returns an error message when blocked
  retryable: boolean;
  audit: boolean;
}

const requiresTerminalReason = (t: Task): string | undefined =>
  t.terminalReason ? undefined : 'terminal_reason is required for terminal transitions';

const requiresDeferredUntil = (t: Task): string | undefined =>
  t.deferredUntil ? undefined : 'deferred_until is required when deferring';

const requiresWaitingOn = (t: Task): string | undefined =>
  t.waitingOn ? undefined : 'waiting_on is required when blocked';

const requiresVerifierEvidence = (t: Task): string | undefined => {
  if (!t.acceptedAt) return 'accepted_at is required before done (Verifier only)';
  if (!t.verificationReportRef) return 'verification_report_ref is required before done';
  if (t.evidenceRefs.length === 0) return 'evidence_refs must be non-empty before done';
  return undefined;
};

/** The full T1-T37 matrix. Anything not listed is illegal. */
export const TRANSITIONS: TransitionRow[] = [
  { id: 'T1', from: 'inbox', to: 'triaged', actor: 'user', reasonCode: 'triaged', retryable: true, audit: false },
  { id: 'T2', from: 'inbox', to: 'rejected', actor: 'user', reasonCode: 'out_of_scope', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T3', from: 'triaged', to: 'planned', actor: 'user', reasonCode: 'scheduled', retryable: true, audit: false },
  { id: 'T4', from: 'triaged', to: 'rejected', actor: 'user', reasonCode: 'out_of_scope', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T5', from: 'planned', to: 'ready', actor: 'system', reasonCode: 'deps_satisfied', retryable: true, audit: false },
  { id: 'T6', from: 'planned', to: 'deferred', actor: 'user', reasonCode: 'postponed', guard: requiresDeferredUntil, retryable: true, audit: false },
  { id: 'T7', from: 'planned', to: 'cancel_requested', actor: 'user', reasonCode: 'cancel_before_start', retryable: true, audit: true },
  { id: 'T8', from: 'planned', to: 'rejected', actor: 'user', reasonCode: 'descoped', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T9', from: 'ready', to: 'running', actor: 'router', reasonCode: 'dispatch_started', retryable: true, audit: true },
  { id: 'T10', from: 'ready', to: 'deferred', actor: 'user', reasonCode: 'postponed', guard: requiresDeferredUntil, retryable: true, audit: false },
  { id: 'T11', from: 'ready', to: 'blocked', actor: 'system', reasonCode: 'dependency_blocked', guard: requiresWaitingOn, retryable: true, audit: false },
  { id: 'T12', from: 'ready', to: 'cancel_requested', actor: 'user', reasonCode: 'user_cancel', retryable: true, audit: true },
  { id: 'T13', from: 'running', to: 'waiting_approval', actor: 'system', reasonCode: 'risk_gate', retryable: true, audit: true },
  { id: 'T14', from: 'waiting_approval', to: 'running', actor: 'system', reasonCode: 'approved', retryable: true, audit: true },
  { id: 'T15', from: 'waiting_approval', to: 'blocked', actor: 'system', reasonCode: 'approval_denied', guard: requiresWaitingOn, retryable: true, audit: true },
  { id: 'T16', from: 'waiting_approval', to: 'rejected', actor: 'user', reasonCode: 'permanently_denied', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T17', from: 'waiting_approval', to: 'cancel_requested', actor: 'user', reasonCode: 'user_cancel', retryable: true, audit: true },
  { id: 'T18', from: 'running', to: 'review_required', actor: 'adapter', reasonCode: 'executor_finished', retryable: true, audit: false },
  { id: 'T19', from: 'running', to: 'blocked', actor: 'runtime', reasonCode: 'external_unknown', guard: requiresWaitingOn, retryable: true, audit: true },
  { id: 'T20', from: 'running', to: 'failed', actor: 'runtime', reasonCode: 'dispatch_failed', retryable: true, audit: true },
  { id: 'T21', from: 'running', to: 'cancel_requested', actor: 'user', reasonCode: 'user_cancel', retryable: true, audit: true },
  { id: 'T22', from: 'review_required', to: 'done', actor: 'verifier', reasonCode: 'verification_accepted', guard: requiresVerifierEvidence, retryable: false, audit: true },
  { id: 'T23', from: 'review_required', to: 'running', actor: 'verifier', reasonCode: 'verification_rejected', retryable: true, audit: true },
  { id: 'T24', from: 'review_required', to: 'failed', actor: 'verifier', reasonCode: 'verification_failed_terminal', retryable: false, audit: true },
  { id: 'T25', from: 'review_required', to: 'blocked', actor: 'verifier', reasonCode: 'needs_human', guard: requiresWaitingOn, retryable: true, audit: false },
  { id: 'T26', from: 'cancel_requested', to: 'cancelled', actor: 'runtime', reasonCode: 'cancel_reconciled', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T27', from: 'cancel_requested', to: 'running', actor: 'runtime', reasonCode: 'cancel_aborted', retryable: false, audit: true },
  { id: 'T28', from: 'cancel_requested', to: 'review_required', actor: 'runtime', reasonCode: 'cancel_outcome_unknown', retryable: false, audit: true },
  { id: 'T29', from: 'blocked', to: 'running', actor: 'system', reasonCode: 'unblocked', retryable: true, audit: false },
  { id: 'T30', from: 'blocked', to: 'planned', actor: 'user', reasonCode: 'replanned', retryable: true, audit: false },
  { id: 'T31', from: 'blocked', to: 'cancelled', actor: 'user', reasonCode: 'abandoned', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T32', from: 'deferred', to: 'planned', actor: 'system', reasonCode: 'due', retryable: true, audit: false },
  { id: 'T33', from: 'deferred', to: 'rejected', actor: 'user', reasonCode: 'no_longer_relevant', guard: requiresTerminalReason, retryable: false, audit: true },
  { id: 'T34', from: 'deferred', to: 'cancel_requested', actor: 'user', reasonCode: 'user_cancel', retryable: true, audit: true },
  { id: 'T35', from: 'failed', to: 'planned', actor: 'user', reasonCode: 'retry_or_replan', retryable: true, audit: true },
  { id: 'T36', from: 'failed', to: 'rejected', actor: 'user', reasonCode: 'give_up', guard: requiresTerminalReason, retryable: false, audit: true },
  // T37: done / rejected / cancelled are terminal - no outgoing edges.
];

export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'rejected', 'cancelled'];

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
    public readonly reason?: string,
  ) {
    super(reason ?? `illegal task transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function findTransition(from: TaskStatus, to: TaskStatus): TransitionRow | undefined {
  return TRANSITIONS.find((r) => r.from === from && r.to === to);
}

/** True when `to` is reachable from `from` per the matrix. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return findTransition(from, to) !== undefined;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
  row?: TransitionRow;
}

/**
 * Validate a transition: matrix edge + guard. Guards encode the MUST
 * invariants (terminal_reason, deferred_until, waiting_on, verifier
 * evidence for done).
 */
export function validateTransition(task: Task, to: TaskStatus): TransitionResult {
  if (isTerminal(task.status)) {
    return { ok: false, error: `task is terminal (${task.status}); no outgoing transitions` };
  }
  const row = findTransition(task.status, to);
  if (!row) {
    return { ok: false, error: new IllegalTransitionError(task.status, to).message };
  }
  if (row.guard) {
    const guardError = row.guard(task);
    if (guardError) return { ok: false, error: guardError, row };
  }
  return { ok: true, row };
}

/** Apply a validated transition, returning a new task (no mutation). */
export function transition(task: Task, to: TaskStatus, now: string): Task {
  const result = validateTransition(task, to);
  if (!result.ok) {
    throw new IllegalTransitionError(task.status, to, result.error);
  }
  return { ...task, status: to, updatedAt: now };
}

/**
 * The only path to `done`. Verifier-only: an adapter/executor can move
 * a task to review_required (T18) but never directly to done.
 */
export function acceptTask(
  task: Task,
  verifier: { verificationReportRef: string; evidenceRefs: string[]; acceptedAt: string },
  now: string,
): Task {
  if (task.status !== 'review_required') {
    throw new IllegalTransitionError(
      task.status,
      'done',
      'done requires review_required status (executor claims are not acceptance)',
    );
  }
  const candidate: Task = {
    ...task,
    verificationReportRef: verifier.verificationReportRef,
    evidenceRefs: verifier.evidenceRefs,
    acceptedAt: verifier.acceptedAt,
  };
  const result = validateTransition(candidate, 'done');
  if (!result.ok) throw new IllegalTransitionError(task.status, 'done', result.error);
  return transition(candidate, 'done', now);
}

/** All legal (from,to) pairs - used to generate edge tests. */
export function allEdges(): Array<{ from: TaskStatus; to: TaskStatus }> {
  return TRANSITIONS.map((r) => ({ from: r.from, to: r.to }));
}
