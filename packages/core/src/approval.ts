/**
 * Approval gate v2 (design §12.1, §12.3).
 *
 * Rules:
 *  - R0-R2 are policy auto-approved and recorded; R3 requires a human
 *    decision; R4 requires a human decision + explicit token + one-time
 *    nonce bound to run_id + step_id + action_hash + resource scope.
 *  - An approval is consumed exactly once (consumed_at).
 *  - If the bound action or scope changes, the approval is superseded
 *    and must be re-decided (replay/misuse defence).
 *  - Expired approvals never pass.
 */
import type { Approval, ApprovalDecision, RiskLevel, Task } from './types.js';
import { RISK_APPROVAL } from '@paos/contracts';
import { createHash } from 'node:crypto';

export class ApprovalDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalDeniedError';
  }
}

/** sha256 of the exact action string (used for binding). */
export function hashAction(action: string): string {
  return createHash('sha256').update(action, 'utf8').digest('hex');
}

export function hashScope(scope: string[]): string {
  return createHash('sha256').update([...scope].sort().join('\n'), 'utf8').digest('hex');
}

export interface CreateApprovalInput {
  id: string;
  workflowRunId: string;
  stepId: string;
  risk: RiskLevel;
  action: string;
  resourceScope: string[];
  now: string;
  expiresAt?: string;
}

export function createApproval(input: CreateApprovalInput): Approval {
  const needsNonce = input.risk === 'R3' || input.risk === 'R4';
  return {
    id: input.id,
    workflowRunId: input.workflowRunId,
    stepId: input.stepId,
    risk: input.risk,
    action: input.action,
    actionHash: hashAction(input.action),
    resourceScopeHash: hashScope(input.resourceScope),
    nonce: needsNonce ? randomNonce() : undefined,
    decision: 'pending',
    createdAt: input.now,
    updatedAt: input.now,
    expiresAt: input.expiresAt,
  };
}

export function randomNonce(): string {
  return createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${process.pid}`)
    .digest('base64url')
    .slice(0, 22);
}

/** Record a human decision. Approvals must name the decider. */
export function decide(
  approval: Approval,
  decision: Extract<ApprovalDecision, 'approved' | 'denied'>,
  decidedBy: string,
  decidedAt: string,
): Approval {
  if (approval.decision !== 'pending') {
    throw new ApprovalDeniedError(`approval ${approval.id} is ${approval.decision}; cannot re-decide`);
  }
  if (decision === 'approved' && !decidedBy) {
    throw new ApprovalDeniedError('approval requires a named human decider');
  }
  return { ...approval, decision, decidedBy, decidedAt, updatedAt: decidedAt };
}

/** The bound action or scope changed -> approval is void, re-decide. */
export function supersede(approval: Approval, now: string): Approval {
  if (approval.decision === 'consumed') return approval; // already spent
  return { ...approval, decision: 'superseded', updatedAt: now };
}

export function isSupersededByChange(approval: Approval, action: string, scope: string[]): boolean {
  return approval.actionHash !== hashAction(action) || approval.resourceScopeHash !== hashScope(scope);
}

export interface GateOptions {
  now: string;
  /** The exact action about to execute (must match the binding). */
  action: string;
  resourceScope: string[];
}

function isExpired(approval: Approval, now: string): boolean {
  return Boolean(approval.expiresAt && now > approval.expiresAt);
}

/**
 * Gate check before execution. Throws ApprovalDeniedError unless the
 * approval is approved, unexpired, unconsumed, matches the exact action
 * and scope, and satisfies the risk requirement (R4 token).
 */
export function checkGate(approval: Approval, opts: GateOptions): void {
  if (approval.decision === 'denied') {
    throw new ApprovalDeniedError(`approval ${approval.id} denied`);
  }
  if (approval.decision === 'expired' || approval.decision === 'superseded') {
    throw new ApprovalDeniedError(`approval ${approval.id} ${approval.decision}`);
  }
  if (approval.decision === 'consumed') {
    throw new ApprovalDeniedError(`approval ${approval.id} already consumed (replay rejected)`);
  }
  if (approval.decision !== 'approved') {
    throw new ApprovalDeniedError(`approval ${approval.id} still pending`);
  }
  if (isExpired(approval, opts.now)) {
    throw new ApprovalDeniedError(`approval ${approval.id} expired at ${approval.expiresAt}`);
  }
  if (isSupersededByChange(approval, opts.action, opts.resourceScope)) {
    throw new ApprovalDeniedError(
      `approval ${approval.id} does not bind this exact action/scope (superseded; re-decide)`,
    );
  }
  const requirement = RISK_APPROVAL[approval.risk];
  if (requirement === 'human-required' || requirement === 'human-token-nonce') {
    if (!approval.decidedBy) {
      throw new ApprovalDeniedError(`${approval.risk} requires a named human decider`);
    }
    if (!approval.nonce) {
      throw new ApprovalDeniedError(`${approval.risk} requires a one-time nonce`);
    }
  }
  if (requirement === 'human-token-nonce' && !approval.token) {
    throw new ApprovalDeniedError('R4 requires an explicit human token');
  }
}

/** Consume an approval exactly once. */
export function consume(approval: Approval, now: string): Approval {
  if (approval.consumedAt) {
    throw new ApprovalDeniedError(`approval ${approval.id} already consumed at ${approval.consumedAt}`);
  }
  if (approval.decision !== 'approved') {
    throw new ApprovalDeniedError(`only approved approvals can be consumed (got ${approval.decision})`);
  }
  return { ...approval, decision: 'consumed', consumedAt: now, updatedAt: now };
}

/** Does this risk level need a human at all? */
export function requiresHuman(risk: RiskLevel): boolean {
  return RISK_APPROVAL[risk] !== 'auto-recorded';
}

/** Attach the human token for R4. */
export function attachToken(approval: Approval, token: string, now: string): Approval {
  if (approval.risk !== 'R4') {
    throw new ApprovalDeniedError('only R4 approvals take a token');
  }
  if (!token) throw new ApprovalDeniedError('token must be non-empty');
  return { ...approval, token, updatedAt: now };
}

/** Risk a task carries today, for gate wiring in runtime. */
export function taskRisk(task: Task): RiskLevel {
  return task.risk;
}
