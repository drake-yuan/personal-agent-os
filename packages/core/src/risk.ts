/**
 * Risk classification, deny-first (design Section 3).
 *
 * classifyAction() maps a planned action to R0-R4. Unrecognized
 * actions default to R4 (v1.0 was R3; V2.0 tightens): the OS refuses
 * to guess, and a task must be explicitly downgraded by the user with
 * an audit record.
 */
import type { RiskLevel } from './types.js';

const R4_KEYWORDS = [
  'send', 'delete', 'trade', 'pay', 'publish', 'submit', 'apply',
  'execute-order', 'transfer', 'wire', 'sign', 'purchase', 'sell', 'buy',
];
const R3_KEYWORDS = ['webhook', 'external-api', 'post-message', 'notify-external', 'publish-draft'];
const R2_KEYWORDS = ['write', 'create', 'update', 'migrate', 'commit', 'edit'];
const R1_KEYWORDS = ['draft', 'generate', 'summarize', 'plan', 'outline'];
const R0_KEYWORDS = ['read', 'list', 'search', 'query', 'fetch', 'inspect', 'digest'];

export function classifyAction(action: string): RiskLevel {
  const lower = action.toLowerCase();
  if (R4_KEYWORDS.some((k) => lower.includes(k))) return 'R4';
  if (R3_KEYWORDS.some((k) => lower.includes(k))) return 'R3';
  if (R2_KEYWORDS.some((k) => lower.includes(k))) return 'R2';
  if (R1_KEYWORDS.some((k) => lower.includes(k))) return 'R1';
  if (R0_KEYWORDS.some((k) => lower.includes(k))) return 'R0';
  return 'R4'; // deny-first: unknown actions are treated as high-impact
}

/** Minimum risk that requires a human decision (R3+). */
export function humanGateThreshold(): RiskLevel {
  return 'R3';
}

/**
 * v1 -> v2 risk mapping (design Section 3, MUST). Applied once by migration
 * 0001 and kept here as the single mapping function.
 */
export function migrateRisk(v1: 'R0' | 'R1' | 'R2' | 'R3'): RiskLevel {
  switch (v1) {
    case 'R0': return 'R0';
    case 'R1': return 'R2'; // local write, reversible
    case 'R2': return 'R3'; // external side effect, recoverable
    case 'R3': return 'R4'; // irreversible
  }
}

/** v1 task status -> v2 task status (design Section 6.3 rule 5). */
export function migrateTaskStatus(v1: string): string {
  switch (v1) {
    case 'awaiting_approval': return 'waiting_approval';
    case 'planned': return 'ready'; // deps assumed satisfied unless data says otherwise
    default: return v1; // inbox/triaged/running/blocked/done/rejected unchanged
  }
}
