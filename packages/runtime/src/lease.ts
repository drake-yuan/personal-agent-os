/**
 * Worker lease with compare-and-set (design Section 11.3, P1-01).
 *
 * Single active executor per run: a lease is claimed in one
 * transaction with a CAS UPDATE. Heartbeats extend the lease. The
 * expiry threshold is derived from the adapter's max silent interval
 * (x2), never a hardcoded 15 minutes.
 */
export interface LeaseRow {
  workflowRunId: string;
  workerId: string;
  leaseUntil: string;
  heartbeatAt: string;
}

export interface LeaseStore {
  get(runId: string): LeaseRow | undefined;
  /** CAS claim: succeeds only if unclaimed or expired. */
  claim(runId: string, workerId: string, leaseUntil: string, now: string): boolean;
  /** CAS extend: succeeds only if we still hold the lease. */
  heartbeat(runId: string, workerId: string, leaseUntil: string, now: string): boolean;
  release(runId: string, workerId: string): void;
}

export class InMemoryLeaseStore implements LeaseStore {
  private rows = new Map<string, LeaseRow>();

  get(runId: string): LeaseRow | undefined {
    return this.rows.get(runId);
  }

  claim(runId: string, workerId: string, leaseUntil: string, now: string): boolean {
    const current = this.rows.get(runId);
    if (current && current.leaseUntil > now && current.workerId !== workerId) {
      return false; // held by a live worker
    }
    this.rows.set(runId, { workflowRunId: runId, workerId, leaseUntil, heartbeatAt: now });
    return true;
  }

  heartbeat(runId: string, workerId: string, leaseUntil: string, now: string): boolean {
    const current = this.rows.get(runId);
    if (!current || current.workerId !== workerId) return false;
    this.rows.set(runId, { workflowRunId: runId, workerId, leaseUntil, heartbeatAt: now });
    return true;
  }

  release(runId: string, workerId: string): void {
    const current = this.rows.get(runId);
    if (current && current.workerId === workerId) this.rows.delete(runId);
  }
}

/**
 * Heartbeat timeout threshold = adapter max silent interval x 2
 * (design Section 11.3). Never a hardcoded constant.
 */
export function heartbeatTimeoutMs(adapterMaxSilentMs: number): number {
  return adapterMaxSilentMs * 2;
}

/** Is the lease expired at `now`? */
export function isLeaseExpired(row: LeaseRow, now: string): boolean {
  return row.leaseUntil <= now;
}
