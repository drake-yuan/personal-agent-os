import { describe, expect, it } from 'vitest';
import {
  createApproval, decide, checkGate, consume, supersede, attachToken,
  isSupersededByChange, hashAction, hashScope, randomNonce, requiresHuman,
  ApprovalDeniedError,
} from '../src/approval.js';

const NOW = '2026-10-25T12:00:00+08:00';
const LATER = '2026-10-25T13:00:00+08:00';

function r3() {
  return createApproval({
    id: 'a1', workflowRunId: 'wfr1', stepId: 's1', risk: 'R3',
    action: 'send email to MUFG', resourceScope: ['mail:outbox'], now: NOW,
  });
}
function r4() {
  return createApproval({
    id: 'a2', workflowRunId: 'wfr1', stepId: 's1', risk: 'R4',
    action: 'sell 1000 CTT shares', resourceScope: ['broker:cettire'], now: NOW,
  });
}

describe('approval gate v2 (nonce / action_hash / consume-once)', () => {
  it('creates R3/R4 approvals with a one-time nonce', () => {
    const a = r3();
    expect(a.nonce).toBeDefined();
    expect(a.nonce).toHaveLength(22);
    expect(r4().nonce).toBeDefined();
    expect(randomNonce()).not.toBe(randomNonce());
  });

  it('R0-R2 approvals carry no nonce', () => {
    const a = createApproval({
      id: 'a0', workflowRunId: 'w', stepId: 's', risk: 'R2',
      action: 'write file', resourceScope: ['src/'], now: NOW,
    });
    expect(a.nonce).toBeUndefined();
  });

  it('pending approvals never pass the gate', () => {
    expect(() => checkGate(r3(), { now: NOW, action: 'send email to MUFG', resourceScope: ['mail:outbox'] }))
      .toThrow(ApprovalDeniedError);
  });

  it('R3 passes only with a named human decider', () => {
    const approved = decide(r3(), 'approved', 'Drake', NOW);
    expect(() => checkGate(approved, { now: NOW, action: 'send email to MUFG', resourceScope: ['mail:outbox'] }))
      .not.toThrow();
    const noName = { ...approved, decidedBy: undefined };
    expect(() => checkGate(noName, { now: NOW, action: 'send email to MUFG', resourceScope: ['mail:outbox'] }))
      .toThrow(/decider/);
  });

  it('R4 requires an explicit human token on top of the decider', () => {
    const approved = decide(r4(), 'approved', 'Drake', NOW);
    expect(() => checkGate(approved, { now: NOW, action: 'sell 1000 CTT shares', resourceScope: ['broker:cettire'] }))
      .toThrow(/token/);
    const tokened = attachToken(approved, 'tok_ok', NOW);
    expect(() => checkGate(tokened, { now: NOW, action: 'sell 1000 CTT shares', resourceScope: ['broker:cettire'] }))
      .not.toThrow();
  });

  it('attachToken refuses non-R4 approvals', () => {
    expect(() => attachToken(decide(r3(), 'approved', 'Drake', NOW), 'x', NOW)).toThrow(ApprovalDeniedError);
  });

  it('action/scope change supersedes the approval (replay defence)', () => {
    const approved = decide(r4(), 'approved', 'Drake', NOW);
    const tokened = attachToken(approved, 'tok', NOW);
    expect(isSupersededByChange(tokened, 'sell 2000 CTT shares', ['broker:cettire'])).toBe(true);
    expect(isSupersededByChange(tokened, 'sell 1000 CTT shares', ['broker:other'])).toBe(true);
    expect(isSupersededByChange(tokened, 'sell 1000 CTT shares', ['broker:cettire'])).toBe(false);
    expect(() => checkGate(tokened, { now: NOW, action: 'sell 2000 CTT shares', resourceScope: ['broker:cettire'] }))
      .toThrow(/superseded|does not bind/);
  });

  it('consumed approvals cannot be replayed', () => {
    const approved = attachToken(decide(r4(), 'approved', 'Drake', NOW), 'tok', NOW);
    const consumed = consume(approved, NOW);
    expect(consumed.consumedAt).toBe(NOW);
    expect(() => checkGate(consumed, { now: LATER, action: 'sell 1000 CTT shares', resourceScope: ['broker:cettire'] }))
      .toThrow(/already consumed/);
    expect(() => consume(consumed, LATER)).toThrow(/already consumed/);
  });

  it('expired approvals never pass', () => {
    const a = decide(r3(), 'approved', 'Drake', NOW);
    const withExpiry = { ...a, expiresAt: NOW };
    expect(() => checkGate(withExpiry, { now: LATER, action: 'send email to MUFG', resourceScope: ['mail:outbox'] }))
      .toThrow(/expired/);
  });

  it('denied approvals never pass and cannot be re-decided', () => {
    const denied = decide(r3(), 'denied', 'Drake', NOW);
    expect(() => checkGate(denied, { now: NOW, action: 'send email to MUFG', resourceScope: ['mail:outbox'] }))
      .toThrow(/denied/);
    expect(() => decide(denied, 'approved', 'Drake', NOW)).toThrow(/cannot re-decide/);
  });

  it('superseded approvals never pass', () => {
    const s = supersede(decide(r3(), 'approved', 'Drake', NOW), NOW);
    expect(s.decision).toBe('superseded');
    expect(() => checkGate(s, { now: NOW, action: 'send email to MUFG', resourceScope: ['mail:outbox'] }))
      .toThrow(/superseded/);
  });

  it('requiresHuman is true only for R3/R4', () => {
    expect(requiresHuman('R0')).toBe(false);
    expect(requiresHuman('R2')).toBe(false);
    expect(requiresHuman('R3')).toBe(true);
    expect(requiresHuman('R4')).toBe(true);
  });

  it('hashes are stable and scope-order independent', () => {
    expect(hashAction('send email')).toBe(hashAction('send email'));
    expect(hashScope(['a', 'b'])).toBe(hashScope(['b', 'a']));
    expect(hashScope(['a', 'b'])).not.toBe(hashScope(['a', 'c']));
  });
});
