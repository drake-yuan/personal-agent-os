import { describe, expect, it } from 'vitest';
import {
  reduceDispatch, canDispatchTransition, mayAutoRetry, recoverFromFault,
  DispatchTransitionError,
} from '../src/outbox.js';
import { DISPATCH_STATE } from '@paos/contracts';
import type { DispatchIntent } from '../src/index.js';

const NOW = '2026-10-25T12:00:00+08:00';

function intent(overrides: Partial<DispatchIntent> = {}): DispatchIntent {
  return {
    id: 'd1',
    workflowRunId: 'wfr1',
    stepId: 'delegate',
    adapterId: 'demo-adapter',
    provider: 'demo',
    idempotencyKey: 'key-1',
    contractHash: 'hash-1',
    state: 'pending',
    supportsServerIdempotency: false,
    attemptCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('dispatch outbox state machine (P0-03)', () => {
  it('walks the happy path pending -> dispatching -> accepted -> reconciled', () => {
    let d = reduceDispatch(intent(), { type: 'dispatch', at: NOW });
    expect(d.state).toBe('dispatching');
    d = reduceDispatch(d, { type: 'response-ok', providerTaskId: 'task-1', at: NOW });
    expect(d.state).toBe('accepted');
    expect(d.providerTaskId).toBe('task-1');
    d = reduceDispatch(d, { type: 'reconcile', at: NOW });
    expect(d.state).toBe('reconciled');
  });

  it('rejects unknown pairs and terminal reconciled', () => {
    expect(canDispatchTransition('pending', 'response-ok')).toBe(false);
    expect(canDispatchTransition('reconciled', 'dispatch')).toBe(false);
    expect(() => reduceDispatch(intent(), { type: 'response-ok', providerTaskId: 'x', at: NOW }))
      .toThrow(DispatchTransitionError);
  });

  it('timeout becomes unknown_outcome - never silently failed', () => {
    const d = reduceDispatch(reduceDispatch(intent(), { type: 'dispatch', at: NOW }), { type: 'timeout', at: NOW });
    expect(d.state).toBe('unknown_outcome');
    expect(d.state).not.toBe('failed');
    const reconciled = reduceDispatch(d, { type: 'reconcile', providerTaskId: 'task-9', at: NOW });
    expect(reconciled.state).toBe('reconciled');
  });

  it('response error is retryable and counts attempts', () => {
    const d = reduceDispatch(reduceDispatch(intent(), { type: 'dispatch', at: NOW }), {
      type: 'response-error', error: 'boom', at: NOW,
    });
    expect(d.state).toBe('rejected');
    expect(d.attemptCount).toBe(1);
    expect(mayAutoRetry(d)).toBe(false); // server idempotency not proven
    expect(mayAutoRetry({ ...d, supportsServerIdempotency: true })).toBe(true);
  });

  it('all six states exist and every legal edge is enumerable', () => {
    expect(DISPATCH_STATE).toEqual(['pending', 'dispatching', 'accepted', 'rejected', 'unknown_outcome', 'reconciled']);
    const legal: Array<[string, string]> = [
      ['pending', 'dispatch'], ['dispatching', 'response-ok'], ['dispatching', 'response-error'],
      ['dispatching', 'timeout'], ['accepted', 'reconcile'], ['rejected', 'dispatch'],
      ['unknown_outcome', 'reconcile'], ['unknown_outcome', 'human-resolved'],
    ];
    for (const [state, event] of legal) {
      expect(canDispatchTransition(state as never, event as never)).toBe(true);
    }
  });

  it('five fault-injection points never create a silent duplicate', () => {
    const cases: Array<[Parameters<typeof recoverFromFault>[1], string]> = [
      ['crash-before-send', 'resume-dispatch'],
      ['crash-after-send-before-response', 'reconcile-remote'],
      ['crash-after-task-id-before-db-commit', 'reconcile-remote'],
      ['duplicate-button-request', 'no-duplicate-created'],
      ['remote-cancel-failed', 'ask-human'],
    ];
    for (const [fault, expected] of cases) {
      const decision = recoverFromFault(intent(), fault);
      expect(decision.action, fault).toBe(expected);
    }
  });

  it('reducer is pure (does not mutate the input)', () => {
    const before = intent();
    const snapshot = JSON.stringify(before);
    reduceDispatch(before, { type: 'dispatch', at: NOW });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
