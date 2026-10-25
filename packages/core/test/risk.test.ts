import { describe, expect, it } from 'vitest';
import { classifyAction, migrateRisk, migrateTaskStatus } from '../src/risk.js';

describe('risk classification: deny-first', () => {
  it('maps high-impact actions to R4', () => {
    for (const a of ['send email', 'delete record', 'trade order', 'pay invoice', 'publish post', 'submit application', 'wire funds']) {
      expect(classifyAction(a), a).toBe('R4');
    }
  });

  it('maps recoverable external effects to R3', () => {
    expect(classifyAction('webhook notify')).toBe('R3');
    expect(classifyAction('external-api call')).toBe('R3');
  });

  it('maps local writes to R2 and drafts to R1', () => {
    expect(classifyAction('write file')).toBe('R2');
    expect(classifyAction('commit change')).toBe('R2');
    expect(classifyAction('draft reply')).toBe('R1');
    expect(classifyAction('generate outline')).toBe('R1');
  });

  it('read-only actions are R0', () => {
    expect(classifyAction('read digest')).toBe('R0');
  });

  it('unknown actions default to R4 (V2.0 tightened from R3)', () => {
    expect(classifyAction('totally unknown thing')).toBe('R4');
    expect(classifyAction('')).toBe('R4');
  });
});

describe('v1 -> v2 migration mapping (Section 3 mapping table)', () => {
  it('maps risk levels one level up (local write becomes R2, external R3, irreversible R4)', () => {
    expect(migrateRisk('R0')).toBe('R0');
    expect(migrateRisk('R1')).toBe('R2');
    expect(migrateRisk('R2')).toBe('R3');
    expect(migrateRisk('R3')).toBe('R4');
  });

  it('maps awaiting_approval -> waiting_approval', () => {
    expect(migrateTaskStatus('awaiting_approval')).toBe('waiting_approval');
  });

  it('maps planned -> ready; other statuses unchanged', () => {
    expect(migrateTaskStatus('planned')).toBe('ready');
    for (const s of ['inbox', 'triaged', 'running', 'blocked', 'done', 'rejected']) {
      expect(migrateTaskStatus(s)).toBe(s);
    }
  });
});
