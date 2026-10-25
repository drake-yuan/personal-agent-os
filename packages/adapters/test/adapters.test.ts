import { describe, expect, it } from 'vitest';
import { DemoAdapter, doctor, AdapterRegistry } from '../src/index.js';

const FIXTURES = [
  {
    providerTaskId: 'demo-task-1',
    providerStatus: 'completed',
    exitCode: 0,
    artifacts: [{ artifact_id: 'art1', kind: 'change_summary', sha256: 'a'.repeat(64), media_type: 'application/json', bytes: 100 }],
  },
];

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1', workflowRunId: 'w1', stepId: 'delegate', adapterId: 'demo-adapter',
    provider: 'demo', idempotencyKey: 'key-1', contractHash: 'h1', state: 'pending',
    supportsServerIdempotency: true, attemptCount: 0,
    createdAt: '2026-10-25T12:00:00+08:00', updatedAt: '2026-10-25T12:00:00+08:00',
    ...overrides,
  } as never;
}

describe('demo adapter (zero-secret fixture executor)', () => {
  it('probes healthy with enforced workspace isolation', async () => {
    const health = await new DemoAdapter(FIXTURES).probe();
    expect(health.installed).toBe(true);
    expect(health.enforcedIsolation).toBe('workspace-fs');
    expect(health.unconfined).toBe(false);
    expect(health.supportsServerIdempotency).toBe(true);
  });

  it('dispatch returns a provider task id from the fixture', async () => {
    const adapter = new DemoAdapter(FIXTURES);
    const outcome = await adapter.dispatch(intent(), { plan: await adapter.plan({ contract: {}, workspace: '.' }) });
    expect(outcome.transport).toBe('ok');
    expect(outcome.providerTaskId).toBe('demo-task-1');
  });

  it('simulated transport failures surface as transport errors', async () => {
    const adapter = new DemoAdapter(FIXTURES);
    adapter.nextTransportFailure = 'timeout';
    const outcome = await adapter.dispatch(intent(), { plan: await adapter.plan({ contract: {}, workspace: '.' }) });
    expect(outcome.transport).toBe('timeout');
  });

  it('mapResult reports observations only - never accepted', async () => {
    const adapter = new DemoAdapter(FIXTURES);
    const result = adapter.mapResult({ provider: 'demo', exitCode: 0 }) as Record<string, unknown>;
    expect(result.result_version).toBe('1.1');
    expect(result.provider_status).toBe('completed');
    expect('accepted' in result).toBe(false);
    const failed = adapter.mapResult({ provider: 'demo', exitCode: 1 }) as Record<string, unknown>;
    expect(failed.provider_status).toBe('failed');
  });

  it('reconcile reads back the fixture status', async () => {
    const adapter = new DemoAdapter(FIXTURES);
    const obs = await adapter.reconcile('demo-task-1');
    expect(obs.providerStatus).toBe('completed');
    const unknown = await adapter.reconcile('nope');
    expect(unknown.providerStatus).toBe('unknown');
  });

  it('cancel confirms both local and remote', async () => {
    const outcome = await new DemoAdapter(FIXTURES).cancel('run-1');
    expect(outcome).toEqual({ local: 'stopped', remote: 'confirmed' });
  });
});

describe('doctor five levels (P2-07)', () => {
  it('all five levels pass for a healthy adapter', async () => {
    const rows = doctor('demo-adapter', await new DemoAdapter(FIXTURES).probe());
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it('offline adapters fail live_connectivity with a next step', async () => {
    const health = { ...(await new DemoAdapter(FIXTURES).probe()), liveConnectivity: false };
    const rows = doctor('demo-adapter', health);
    const live = rows.find((r) => r.level === 'live_connectivity')!;
    expect(live.ok).toBe(false);
    expect(live.code).toBe('E_OFFLINE');
    expect(live.nextStep).toContain('network');
  });
});

describe('adapter registry', () => {
  it('filters by enforced capabilities and isolation', async () => {
    const registry = new AdapterRegistry();
    const adapter = new DemoAdapter(FIXTURES);
    registry.register(adapter);
    const health = await adapter.probe();
    const healthOf = () => health;
    expect(registry.eligible(['fs.read.workspace'], false, healthOf)).toHaveLength(1);
    expect(registry.eligible(['external.send'], false, healthOf)).toHaveLength(0);
    expect(registry.eligible(['fs.read.workspace'], true, healthOf)).toHaveLength(1);
    expect(registry.get('demo-adapter')).toBe(adapter);
    expect(registry.get('nope')).toBeUndefined();
  });
});
