/**
 * Runtime-local structural types. Enum types come from the single
 * generation source (@paos/contracts) - never redefined here.
 */
import type {
  TaskStatus, RiskLevel, ApprovalDecision, WorkflowRunStatus, StepStatus,
  DispatchState, Domain, OriginType, DataClassification, TrustLevel,
} from '@paos/contracts';

export type {
  TaskStatus, RiskLevel, ApprovalDecision, WorkflowRunStatus, StepStatus,
  DispatchState, Domain, OriginType, DataClassification, TrustLevel,
};

/** The outbox row: a committed intent to dispatch, persisted before any network call. */
export interface DispatchIntent {
  id: string;
  workflowRunId: string;
  stepId: string;
  adapterId: string;
  provider: string;
  idempotencyKey: string;
  contractHash: string;
  state: DispatchState;
  /** Measured (probed) server idempotency - only this may gate auto-retry. */
  supportsServerIdempotency: boolean;
  providerTaskId?: string;
  attemptCount: number;
  lastError?: string;
  dispatchedAt?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}
