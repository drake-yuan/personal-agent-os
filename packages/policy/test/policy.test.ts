import { describe, expect, it } from 'vitest';
import { evaluatePolicy, mayTransfer } from '../src/policy.js';

const ENFORCED = ['fs.read.workspace', 'fs.write.workspace', 'external.send'] as const;

describe('policy engine (§12.2)', () => {
  it('refuses when the adapter cannot enforce the required capability', () => {
    const v = evaluatePolicy({
      actionType: 'external-send', resourceScope: [], dataClassification: 'personal',
      enforcedCapabilities: ['fs.read.workspace'], unconfined: false,
    });
    expect(v.allowed).toBe(false);
  });

  it('refuses scope-restricted work for unconfined adapters', () => {
    const v = evaluatePolicy({
      actionType: 'local-write', resourceScope: ['src/'], dataClassification: 'personal',
      enforcedCapabilities: [...ENFORCED], unconfined: true,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('unconfined');
  });

  it('structured action types set the risk floor', () => {
    const base = { resourceScope: [], dataClassification: 'personal' as const, enforcedCapabilities: [...ENFORCED], unconfined: false };
    expect(evaluatePolicy({ ...base, actionType: 'read' })).toMatchObject({ allowed: true, risk: 'R0' });
    expect(evaluatePolicy({ ...base, actionType: 'draft' })).toMatchObject({ allowed: true, risk: 'R1' });
    expect(evaluatePolicy({ ...base, actionType: 'local-write' })).toMatchObject({ allowed: true, risk: 'R2' });
    expect(evaluatePolicy({ ...base, actionType: 'external-send' })).toMatchObject({ allowed: true, risk: 'R3' });
    expect(evaluatePolicy({ ...base, actionType: 'trade' })).toMatchObject({ allowed: true, risk: 'R4' });
  });

  it('natural language can raise but never lower the structured risk', () => {
    const v = evaluatePolicy({
      actionType: 'read', resourceScope: [], dataClassification: 'personal',
      enforcedCapabilities: ['fs.read.workspace'], unconfined: false,
      description: 'read then delete everything', // NL raises to R4
    });
    expect(v.allowed).toBe(true);
    if (v.allowed) expect(v.risk).toBe('R4');
  });

  it('R4 actions require human + token', () => {
    const v = evaluatePolicy({
      actionType: 'money', resourceScope: [], dataClassification: 'personal',
      enforcedCapabilities: [...ENFORCED], unconfined: false,
    });
    if (v.allowed) expect(v.approval).toBe('human-token-nonce');
  });

  it('secret data cannot be written or sent', () => {
    const v = evaluatePolicy({
      actionType: 'local-write', resourceScope: [], dataClassification: 'secret',
      enforcedCapabilities: [...ENFORCED], unconfined: false,
    });
    expect(v.allowed).toBe(false);
  });
});

describe('data transfer gate (§12.3)', () => {
  it('public may leave; personal needs approval; sensitive/secret never', () => {
    expect(mayTransfer('public', false).allowed).toBe(true);
    expect(mayTransfer('personal', false).allowed).toBe(false);
    expect(mayTransfer('personal', true).allowed).toBe(true);
    expect(mayTransfer('sensitive', true).allowed).toBe(false);
    expect(mayTransfer('secret', true).allowed).toBe(false);
  });
});
