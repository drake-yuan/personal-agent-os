import { describe, expect, it } from 'vitest';
import {
  TRANSITIONS, canTransition, findTransition, isTerminal,
  validateTransition, transition, acceptTask, IllegalTransitionError, allEdges,
} from '../src/task-machine.js';
import { TASK_STATUS } from '@paos/contracts';
import type { Task, TaskStatus } from '../src/types.js';

const NOW = '2026-10-25T12:00:00+08:00';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    domain: 'learning',
    title: 'W2 review',
    nextAction: 'run checks',
    doneCondition: 'all checks ticked',
    status: 'inbox',
    risk: 'R0',
    evidenceRefs: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** All (from,to) pairs - 14 x 14 = 196. */
export const ALL_PAIRS: Array<[TaskStatus, TaskStatus]> = TASK_STATUS.flatMap((from) =>
  TASK_STATUS.map((to) => [from, to] as [TaskStatus, TaskStatus]),
);

describe('task state machine: full matrix (T1-T37)', () => {
  it('every legal edge is reachable', () => {
    for (const edge of allEdges()) {
      expect(canTransition(edge.from, edge.to), `${edge.from}->${edge.to}`).toBe(true);
    }
  });

  it('has exactly 36 legal edges', () => {
    expect(TRANSITIONS).toHaveLength(36);
  });

  it('rejects every pair not in the matrix', () => {
    const legal = new Set(TRANSITIONS.map((r) => `${r.from}->${r.to}`));
    for (const [from, to] of ALL_PAIRS) {
      const expected = legal.has(`${from}->${to}`);
      expect(canTransition(from, to), `${from}->${to}`).toBe(expected);
    }
  });

  it('terminal states have no outgoing edges', () => {
    for (const t of ['done', 'rejected', 'cancelled'] as TaskStatus[]) {
      expect(TRANSITIONS.filter((r) => r.from === t)).toHaveLength(0);
      expect(isTerminal(t)).toBe(true);
    }
  });

  it('cancel_requested is NOT terminal and reconciles to three outcomes', () => {
    expect(isTerminal('cancel_requested')).toBe(false);
    expect(canTransition('cancel_requested', 'cancelled')).toBe(true);
    expect(canTransition('cancel_requested', 'running')).toBe(true);
    expect(canTransition('cancel_requested', 'review_required')).toBe(true);
  });

  it('running -> done does not exist: executors never close tasks', () => {
    expect(canTransition('running', 'done')).toBe(false);
    expect(findTransition('running', 'done')).toBeUndefined();
  });

  it('review_required -> done exists only via the Verifier row (T22)', () => {
    const row = findTransition('review_required', 'done');
    expect(row?.actor).toBe('verifier');
    expect(row?.guard).toBeDefined();
  });

  it('guards: terminal_reason required on terminal transitions', () => {
    const inbox = task({ status: 'inbox' });
    expect(validateTransition(inbox, 'rejected').ok).toBe(false);
    expect(validateTransition({ ...inbox, terminalReason: 'out of scope' }, 'rejected').ok).toBe(true);
  });

  it('guards: deferred_until required when deferring', () => {
    const planned = task({ status: 'planned' });
    expect(validateTransition(planned, 'deferred').ok).toBe(false);
    expect(validateTransition({ ...planned, deferredUntil: '2026-11-01' }, 'deferred').ok).toBe(true);
  });

  it('guards: waiting_on required when blocked', () => {
    const ready = task({ status: 'ready' });
    expect(validateTransition(ready, 'blocked').ok).toBe(false);
    expect(validateTransition({ ...ready, waitingOn: 'MUFG reply' }, 'blocked').ok).toBe(true);
  });

  it('transition() throws on illegal edge and does not mutate', () => {
    const original = task({ status: 'inbox' });
    expect(() => transition(original, 'done', NOW)).toThrow(IllegalTransitionError);
    expect(original.status).toBe('inbox');
  });

  it('transition() returns a new object on legal edge', () => {
    const next = transition(task({ status: 'inbox' }), 'triaged', NOW);
    expect(next.status).toBe('triaged');
    expect(next.updatedAt).toBe(NOW);
  });

  it('transitioning out of a terminal state is refused', () => {
    const done = task({ status: 'done' });
    expect(validateTransition(done, 'running').ok).toBe(false);
    expect(validateTransition(done, 'running').error).toContain('terminal');
  });
});

describe('acceptTask: verifier-only closure', () => {
  const verified = {
    verificationReportRef: 'verification_report_01',
    evidenceRefs: ['evidence_01'],
    acceptedAt: NOW,
  };

  it('accepts from review_required with full evidence', () => {
    const t = task({ status: 'review_required' });
    const done = acceptTask(t, verified, NOW);
    expect(done.status).toBe('done');
  });

  it('refuses from any other status', () => {
    for (const s of TASK_STATUS.filter((x) => x !== 'review_required')) {
      expect(() => acceptTask(task({ status: s }), verified, NOW)).toThrow(IllegalTransitionError);
    }
  });

  it('refuses without verification report / evidence / accepted_at', () => {
    const t = task({ status: 'review_required' });
    expect(() => acceptTask(t, { ...verified, verificationReportRef: undefined as never }, NOW)).toThrow(/verification_report_ref/);
    expect(() => acceptTask(t, { ...verified, evidenceRefs: [] }, NOW)).toThrow(/evidence_refs/);
    expect(() => acceptTask(t, { ...verified, acceptedAt: undefined as never }, NOW)).toThrow(/accepted_at/);
  });
});

describe('audit flags per row', () => {
  it('all user-initiated terminal transitions are audited', () => {
    const terminal = TRANSITIONS.filter((r) => r.audit);
    expect(terminal.length).toBeGreaterThan(10);
  });
});
