/**
 * Provider status mapping (design §7.2, MUST).
 *
 * The single mapProviderStatus() lives here. Adapters NEVER write task
 * status directly - they report observations; Runtime derives state.
 *
 * WorkflowRun-level mapping: a provider `completed` does NOT make the
 * run `succeeded` - the run stays `running` until the OS-side verify
 * step passes and an acceptance record exists (§6.4 invariant). The
 * task-level observation `review_required` is derived separately via
 * runStatusToTaskObservation.
 *
 *   completed -> running (OS verification pending)
 *   pending -> paused; failed -> failed
 *   idle/planning/working/CREATING -> running
 *   archived/deleted -> cancelled
 *   unreachable -> unknown_outcome (never failed)
 */
import type { WorkflowRunStatus } from './types.js';

export type ProviderName = 'codex' | 'claude-code' | 'gemini' | 'workbuddy' | 'demo';

const MAP: Record<ProviderName, Record<string, WorkflowRunStatus>> = {
  codex: {
    completed: 'running', // executor finished; OS verification not yet done
    failed: 'failed',
    cancelled: 'cancelled',
    running: 'running',
    queued: 'planned',
  },
  'claude-code': {
    completed: 'running',
    failed: 'failed',
    cancelled: 'cancelled',
    running: 'running',
  },
  gemini: {
    completed: 'running',
    failed: 'failed',
    cancelled: 'cancelled',
    running: 'running',
  },
  workbuddy: {
    completed: 'running', // completed != done (G0 hard lesson)
    pending: 'paused',
    failed: 'failed',
    idle: 'running',
    planning: 'running',
    working: 'running',
    creating: 'running',
    archived: 'cancelled',
    deleted: 'cancelled',
  },
  demo: {
    completed: 'running',
    failed: 'failed',
  },
};

export function mapProviderStatus(provider: ProviderName, raw: string): WorkflowRunStatus {
  const table = MAP[provider];
  const mapped = table?.[raw.toLowerCase()];
  return mapped ?? 'unknown_outcome'; // poll timeout / unknown -> unknown, never failed
}

/** Derive the task-level observation from a mapped run status. */
export function runStatusToTaskObservation(
  status: WorkflowRunStatus,
): 'review_required' | 'blocked' | 'failed' | 'cancelled' | 'running' | 'unknown_outcome' | 'paused' {
  switch (status) {
    case 'running': return 'running'; // executor finished; OS verification pending
    case 'paused': return 'paused';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'unknown_outcome': return 'unknown_outcome';
    case 'succeeded': return 'review_required'; // verified run feeds task review
    default: return 'blocked';
  }
}
