/**
 * Domain model v2 (design V2.0 Section 3, Section 6, Section 7).
 *
 * Types are structural mirrors of the SQLite baseline DDL - the DB is
 * the single source of truth for state, this module is the in-memory
 * shape used by the state machine and tests.
 */
import type {
  TaskStatus, RiskLevel, ApprovalDecision, WorkflowRunStatus, StepStatus,
  DispatchState, Domain, OriginType, DataClassification, TrustLevel,
} from '@paos/contracts';

export type {
  TaskStatus, RiskLevel, ApprovalDecision, WorkflowRunStatus, StepStatus,
  DispatchState, Domain, OriginType, DataClassification, TrustLevel,
};

export interface Task {
  id: string;
  domain: Domain;
  projectId?: string;
  goalId?: string;
  title: string;
  nextAction: string;
  doneCondition: string;
  status: TaskStatus;
  risk: RiskLevel;
  terminalReason?: string;
  waitingOn?: string;
  estimateMin?: number;
  actualMin?: number;
  deferredUntil?: string;
  evidenceRefs: string[];        // JSON array in DB; non-empty before done
  verificationReportRef?: string; // Verifier writes; required before done
  acceptedAt?: string;            // required before done
  createdAt: string;
  updatedAt: string;
}

export interface Approval {
  id: string;
  workflowRunId: string;
  stepId: string;
  risk: RiskLevel;
  action: string;
  actionHash: string;             // sha256 of the exact action
  resourceScopeHash: string;
  nonce?: string;                 // R3/R4 one-time
  token?: string;                 // R4 human confirmation token
  decision: ApprovalDecision;
  decidedBy?: string;
  decidedAt?: string;
  consumedAt?: string;            // approvals are consumed once
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: string;
  domain: Domain;
  taskId?: string;
  status: WorkflowRunStatus;
  terminalReason?: string;
  codeVersion: string;            // frozen run snapshot anti-drift
  workerId?: string;
  leaseUntil?: string;
  heartbeatAt?: string;
  inputRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunStep {
  id: number;
  workflowRunId: string;
  stepId: string;
  seq: number;
  kind: 'note' | 'agent-delegate' | 'verify' | 'approval' | 'human-input';
  skillRef?: string;
  inputRef?: string;
  inputSha256?: string;
  outputRef?: string;
  outputSha256?: string;
  status: StepStatus;
  attempt: number;
  maxAttempts: number;
  idempotencyKey?: string;        // mandatory for side-effecting steps
  errorCode?: string;
  error?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface DispatchIntent {
  id: string;
  workflowRunId: string;
  stepId: string;
  adapterId: string;
  provider: string;
  idempotencyKey: string;
  contractHash: string;
  state: DispatchState;
  supportsServerIdempotency: boolean; // only measured-true adapters may auto-retry
  providerTaskId?: string;
  attemptCount: number;
  lastError?: string;
  dispatchedAt?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Executor {
  id: string;
  kind: string;
  /** Declared capabilities (manifest). Never used for hard security decisions. */
  declaredCapabilities: string[];
  /** Enforced capabilities (probed). Only these gate hard decisions. */
  enforcedCapabilities: string[];
  unconfined: boolean;            // cannot enforce isolation -> no scoped tasks
  enforcedIsolation: 'none' | 'workspace-fs' | 'container';
  /** The human user is always trusted; no isolation requirement applies. */
  trusted?: boolean;
  version?: string;
}

export interface DecisionEntry {
  id: string;
  date: string;
  domain: Domain;
  situation: string;
  options: string;
  rationale: string;
  outcome: string;
  lesson: string;
  reviewBy: string;
  evidenceRefs: string[];
  supersededBy?: string;
}

export interface ConflictEntry {
  id: string;
  topic: string;
  claimA: { source: string; value: string };
  claimB: { source: string; value: string };
  registeredAt: string;
  resolvedAt?: string;
}
