/**
 * Dispatch outbox (design §11.2, P0-03).
 *
 * Exactly-once delivery to an external executor cannot be promised
 * unilaterally. The outbox makes the honest version enforceable:
 *
 *   pending ──dispatch──▶ dispatching ──resp ok──▶ accepted ──reconcile──▶ reconciled
 *                              │
 *                              ├──resp err──▶ rejected (retryable: attempt_count+1)
 *                              └──timeout/crash──▶ unknown_outcome ──reconcile/人工──▶ reconciled
 *
 * Rules:
 *  1. The intent row is committed BEFORE any network call (same tx).
 *  2. timeout/crash => unknown_outcome; never silently treated as failed.
 *  3. Auto-retry of creation only when the adapter measured
 *     supports_server_idempotency = true AND the server confirmed the
 *     same key. Otherwise: human reconciliation.
 */
import type { DispatchIntent, DispatchState } from './types.js';

export type DispatchEvent =
  | { type: 'dispatch'; at: string }
  | { type: 'response-ok'; providerTaskId: string; at: string }
  | { type: 'response-error'; error: string; at: string }
  | { type: 'timeout'; at: string }
  | { type: 'reconcile'; providerTaskId?: string; at: string }
  | { type: 'human-resolved'; at: string };

export class DispatchTransitionError extends Error {
  constructor(state: DispatchState, event: DispatchEvent['type']) {
    super(`illegal dispatch transition: ${state} --${event}-->`);
    this.name = 'DispatchTransitionError';
  }
}

const EDGES: Record<DispatchState, DispatchEvent['type'][]> = {
  pending: ['dispatch'],
  dispatching: ['response-ok', 'response-error', 'timeout'],
  accepted: ['reconcile'],
  rejected: ['dispatch'], // retry only with server idempotency proven
  unknown_outcome: ['reconcile', 'human-resolved'],
  reconciled: [],
};

export function canDispatchTransition(from: DispatchState, event: DispatchEvent['type']): boolean {
  return (EDGES[from] ?? []).includes(event);
}

/** Pure reducer: (intent, event) -> new intent. Throws on illegal edges. */
export function reduceDispatch(intent: DispatchIntent, event: DispatchEvent): DispatchIntent {
  if (!canDispatchTransition(intent.state, event.type)) {
    throw new DispatchTransitionError(intent.state, event.type);
  }
  const now = 'at' in event ? event.at : intent.updatedAt;
  switch (event.type) {
    case 'dispatch':
      return { ...intent, state: 'dispatching', dispatchedAt: now, updatedAt: now };
    case 'response-ok':
      return {
        ...intent,
        state: 'accepted',
        providerTaskId: event.providerTaskId,
        attemptCount: intent.attemptCount + 1,
        updatedAt: now,
      };
    case 'response-error':
      return {
        ...intent,
        state: 'rejected',
        lastError: event.error,
        attemptCount: intent.attemptCount + 1,
        updatedAt: now,
      };
    case 'timeout':
      return { ...intent, state: 'unknown_outcome', lastError: 'timeout', updatedAt: now };
    case 'reconcile':
      return {
        ...intent,
        state: 'reconciled',
        providerTaskId: event.providerTaskId ?? intent.providerTaskId,
        resolvedAt: now,
        updatedAt: now,
      };
    case 'human-resolved':
      return { ...intent, state: 'reconciled', resolvedAt: now, updatedAt: now };
  }
}

/**
 * May we automatically re-create the dispatch? Only with measured
 * server idempotency - otherwise a duplicate external task is possible
 * and a human must reconcile.
 */
export function mayAutoRetry(intent: DispatchIntent): boolean {
  return (
    intent.supportsServerIdempotency &&
    (intent.state === 'rejected') &&
    intent.attemptCount < 3
  );
}

/** Exactly the five fault-injection points from design §11.2 rule 6. */
export type FaultPoint =
  | 'crash-before-send'      // intent committed, no network call happened
  | 'crash-after-send-before-response'
  | 'crash-after-task-id-before-db-commit'
  | 'duplicate-button-request'
  | 'remote-cancel-failed';

export interface RecoveryDecision {
  action: 'resume-dispatch' | 'reconcile-remote' | 'ask-human' | 'no-duplicate-created';
  reason: string;
}

/**
 * Decide recovery for a fault point. In every case the rule is the
 * same: never silently create a duplicate external task.
 */
export function recoverFromFault(
  intent: DispatchIntent,
  fault: FaultPoint,
): RecoveryDecision {
  switch (fault) {
    case 'crash-before-send':
      return { action: 'resume-dispatch', reason: 'no network call ever happened; safe to dispatch the committed intent' };
    case 'crash-after-send-before-response':
      return { action: 'reconcile-remote', reason: 'outcome unknown; query remote before any retry' };
    case 'crash-after-task-id-before-db-commit':
      return { action: 'reconcile-remote', reason: 'provider_task_id may exist remotely; match it, do not re-create' };
    case 'duplicate-button-request':
      return { action: 'no-duplicate-created', reason: 'idempotency_key unique index rejects the duplicate insert' };
    case 'remote-cancel-failed':
      return { action: 'ask-human', reason: 'remote cancel unconfirmed -> unknown_outcome + human reconciliation' };
  }
}
