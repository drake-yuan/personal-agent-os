import { describe, expect, it } from 'vitest';
import { mapProviderStatus, runStatusToTaskObservation } from '../src/status-map.js';

describe('provider status mapping (§7.2)', () => {
  it('WorkBuddy completed keeps the run running - it is NOT done', () => {
    // completed != done: the run only succeeds after OS-side verification
    expect(mapProviderStatus('workbuddy', 'completed')).toBe('running');
    expect(mapProviderStatus('workbuddy', 'completed')).not.toBe('succeeded');
  });

  it('WorkBuddy status families map per the design table', () => {
    expect(mapProviderStatus('workbuddy', 'pending')).toBe('paused');
    expect(mapProviderStatus('workbuddy', 'failed')).toBe('failed');
    for (const s of ['idle', 'planning', 'working', 'creating']) {
      expect(mapProviderStatus('workbuddy', s)).toBe('running');
    }
    for (const s of ['archived', 'deleted']) {
      expect(mapProviderStatus('workbuddy', s)).toBe('cancelled');
    }
  });

  it('CLI providers map completed to running (OS verification pending)', () => {
    for (const p of ['codex', 'claude-code', 'gemini', 'demo'] as const) {
      expect(mapProviderStatus(p, 'completed')).toBe('running');
      expect(mapProviderStatus(p, 'failed')).toBe('failed');
    }
  });

  it('unreachable/unknown statuses become unknown_outcome, never failed', () => {
    expect(mapProviderStatus('workbuddy', 'timeout-unknown')).toBe('unknown_outcome');
    expect(mapProviderStatus('codex', '???')).toBe('unknown_outcome');
  });

  it('run status maps to a task observation', () => {
    expect(runStatusToTaskObservation('succeeded')).toBe('review_required');
    expect(runStatusToTaskObservation('unknown_outcome')).toBe('unknown_outcome');
    expect(runStatusToTaskObservation('failed')).toBe('failed');
  });
});
