/**
 * Policy engine (design Section 12.2, P0-02).
 *
 * Natural language is only an auxiliary signal. The final decision is
 * made on structured inputs: action type + resource scope + data
 * classification + ENFORCED adapter capabilities. An adapter that
 * cannot enforce isolation (`unconfined`) never receives a
 * scope-restricted contract, no matter what it declares.
 */
import type { Capability, DataClassification, RiskLevel } from '@paos/contracts';
import { classifyAction, requiresHuman } from '@paos/core';

export interface PolicyInput {
  /** Structured action type - not free text. */
  actionType: 'read' | 'draft' | 'local-write' | 'external-send' | 'money' | 'delete' | 'trade';
  resourceScope: string[];
  dataClassification: DataClassification;
  /** Capabilities the adapter can actually enforce. */
  enforcedCapabilities: Capability[];
  unconfined: boolean;
  /** Natural language hint (auxiliary only). */
  description?: string;
}

export type PolicyVerdict =
  | { allowed: true; risk: RiskLevel; approval: 'auto-recorded' | 'human-required' | 'human-token-nonce' }
  | { allowed: false; reason: string };

const REQUIRED_CAPS: Record<PolicyInput['actionType'], Capability> = {
  read: 'fs.read.workspace',
  draft: 'fs.write.workspace',
  'local-write': 'fs.write.workspace',
  'external-send': 'external.send',
  money: 'external.send',
  delete: 'fs.write.workspace',
  trade: 'external.send',
};

/** Risk floor per structured action type (NL only raises, never lowers). */
const RISK_FLOOR: Record<PolicyInput['actionType'], RiskLevel> = {
  read: 'R0',
  draft: 'R1',
  'local-write': 'R2',
  'external-send': 'R3',
  money: 'R4',
  delete: 'R4',
  trade: 'R4',
};

const RANK: Record<RiskLevel, number> = { R0: 0, R1: 1, R2: 2, R3: 3, R4: 4 };

export function evaluatePolicy(input: PolicyInput): PolicyVerdict {
  const required = REQUIRED_CAPS[input.actionType];
  if (!input.enforcedCapabilities.includes(required)) {
    return { allowed: false, reason: `adapter cannot enforce required capability ${required}` };
  }
  if (input.resourceScope.length > 0 && input.unconfined) {
    return { allowed: false, reason: 'adapter is unconfined; scope-restricted work refused' };
  }
  const structuredRisk = RISK_FLOOR[input.actionType];
  const nlRisk = input.description ? classifyAction(input.description) : 'R0';
  const risk = RANK[nlRisk] > RANK[structuredRisk] ? nlRisk : structuredRisk;

  if (input.dataClassification === 'secret' && input.actionType !== 'read') {
    return { allowed: false, reason: 'secret data may not be written or sent by policy' };
  }
  const approval = requiresHuman(risk)
    ? risk === 'R4' ? 'human-token-nonce' : 'human-required'
    : 'auto-recorded';
  return { allowed: true, risk, approval };
}

/** Data classification gate for outbound transfer (design Section 12.3). */
export function mayTransfer(
  classification: DataClassification,
  userApprovedPersonal: boolean,
): { allowed: boolean; reason: string } {
  switch (classification) {
    case 'public':
      return { allowed: true, reason: 'public data may leave the machine' };
    case 'personal':
      return userApprovedPersonal
        ? { allowed: true, reason: 'personal data with explicit user approval' }
        : { allowed: false, reason: 'personal data requires explicit user approval to leave the machine' };
    case 'sensitive':
      return { allowed: false, reason: 'sensitive data must not leave the machine in v0.1' };
    case 'secret':
      return { allowed: false, reason: 'secret data must never leave the machine' };
  }
}
