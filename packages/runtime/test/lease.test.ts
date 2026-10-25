import { describe, expect, it } from 'vitest';
import { InMemoryLeaseStore, heartbeatTimeoutMs, isLeaseExpired } from '../src/lease.js';

const T0 = '2026-10-25T12:00:00.000Z';
const T1 = '2026-10-25T12:05:00.000Z';

describe('worker lease (P1-01)', () => {
  it('claims a free run and blocks a second worker', () => {
    const store = new InMemoryLeaseStore();
    expect(store.claim('w1', 'worker-a', T1, T0)).toBe(true);
    expect(store.claim('w1', 'worker-b', T1, T0)).toBe(false);
  });

  it('heartbeat only extends for the current holder', () => {
    const store = new InMemoryLeaseStore();
    store.claim('w1', 'worker-a', T1, T0);
    expect(store.heartbeat('w1', 'worker-b', '2026-10-25T13:00:00Z', T0)).toBe(false);
    expect(store.heartbeat('w1', 'worker-a', '2026-10-25T13:00:00Z', T0)).toBe(true);
    expect(store.get('w1')?.leaseUntil).toBe('2026-10-25T13:00:00Z');
  });

  it('expired leases can be preempted (single active executor)', () => {
    const store = new InMemoryLeaseStore();
    store.claim('w1', 'worker-a', T1, T0);
    expect(isLeaseExpired(store.get('w1')!, T1)).toBe(true);
    expect(store.claim('w1', 'worker-b', '2026-10-25T13:00:00Z', T1)).toBe(true);
  });

  it('release only works for the holder', () => {
    const store = new InMemoryLeaseStore();
    store.claim('w1', 'worker-a', T1, T0);
    store.release('w1', 'worker-b');
    expect(store.get('w1')).toBeDefined();
    store.release('w1', 'worker-a');
    expect(store.get('w1')).toBeUndefined();
  });

  it('heartbeat threshold derives from adapter silence, never hardcoded', () => {
    expect(heartbeatTimeoutMs(1000)).toBe(2000);
    expect(heartbeatTimeoutMs(60_000)).toBe(120_000);
  });
});
