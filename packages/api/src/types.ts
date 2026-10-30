/**
 * Cockpit API DTO (ADR-004 typed DTO boundary).
 *
 * This package is the single source of truth for the JSON contract served by
 * `GET /api/snapshot`. The HTTP layer and the view layer import these types
 * instead of reaching into the database schema directly, so neither is coupled
 * to `@paos/db`'s row shape. Row types are re-exported from `@paos/db` (their
 * canonical home) so a single edit there propagates everywhere.
 */
import type {
  TaskRow,
  WorkflowRunRow,
  DispatchIntentRow,
  ApprovalRow,
} from '@paos/db';

export type {
  TaskRow,
  WorkflowRunRow,
  DispatchIntentRow,
  ApprovalRow,
} from '@paos/db';

/**
 * Aggregate counts + distribution maps. The distribution map keys are seeded
 * from the canonical enums (see COCKPIT_DISTRIBUTION_ENUMS) so the UI never
 * shows a stale or partial breakdown when an enum gains or loses a value.
 */
export interface CockpitSummary {
  sqliteVersion: string;
  taskCount: number;
  runCount: number;
  pendingApprovalCount: number;
  dispatchCount: number;
  tasksByStatus: Record<string, number>;
  tasksByRisk: Record<string, number>;
  runsByStatus: Record<string, number>;
  dispatchByState: Record<string, number>;
}

/** The full read-only cockpit payload. */
export interface CockpitSnapshot {
  generatedAt: string;
  dataDir: string;
  summary: CockpitSummary;
  tasks: TaskRow[];
  workflowRuns: WorkflowRunRow[];
  dispatchIntents: DispatchIntentRow[];
  approvals: ApprovalRow[];
}
