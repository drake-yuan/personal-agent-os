/**
 * Single source of truth for every PAOS enum (design doc V2.0 §3).
 *
 * CI runs a drift check: the TS enums, the SQLite CHECK-constraint
 * documentation in packages/db, the JSON Schemas under schemas/ and the
 * state-transition table in packages/core must all agree with this file.
 * One concept, one vocabulary - never two.
 */

export const TASK_STATUS = [
  'inbox', 'triaged', 'planned', 'ready', 'running',
  'waiting_approval', 'cancel_requested', 'review_required', 'blocked', 'deferred',
  'failed', 'done', 'cancelled', 'rejected',
] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const WORKFLOW_RUN_STATUS = [
  'planned', 'running', 'waiting_approval',
  'cancel_requested', 'paused', 'unknown_outcome', 'succeeded', 'partial', 'failed',
  'cancelled', 'reconciled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUS)[number];

export const STEP_STATUS = [
  'pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled',
] as const;
export type StepStatus = (typeof STEP_STATUS)[number];

export const DISPATCH_STATE = [
  'pending', 'dispatching', 'accepted', 'rejected', 'unknown_outcome', 'reconciled',
] as const;
export type DispatchState = (typeof DISPATCH_STATE)[number];

export const APPROVAL_DECISION = [
  'pending', 'approved', 'denied', 'expired', 'consumed', 'superseded',
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISION)[number];

/** Domains are filters over one shared task queue (registry-driven). */
export const DOMAIN = [
  'work', 'career', 'learning', 'venture', 'life', 'investing', 'platform',
] as const;
export type Domain = (typeof DOMAIN)[number];

/** Single risk enum (P0-05): replaces the old R0-R3 / L0-L4 dual track. */
export const RISK_LEVEL = ['R0', 'R1', 'R2', 'R3', 'R4'] as const;
export type RiskLevel = (typeof RISK_LEVEL)[number];

export const RISK_DEF = {
  R0: 'read-only, local, reversible',
  R1: 'draft/generate, no external side effect',
  R2: 'local write, reversible',
  R3: 'external side effect, recoverable',
  R4: 'high-impact / irreversible (money, delete, formal send, trade)',
} as const;

/** Approval requirement per risk level (§3 mapping table, MUST). */
export const RISK_APPROVAL: Record<RiskLevel, 'auto-recorded' | 'human-required' | 'human-token-nonce'> = {
  R0: 'auto-recorded',
  R1: 'auto-recorded',
  R2: 'auto-recorded',
  R3: 'human-required',
  R4: 'human-token-nonce',
};

export const ORIGIN_TYPE = [
  'user_confirmed', 'behavior_inferred', 'ai_observation', 'system_record', 'external_source',
] as const;
export type OriginType = (typeof ORIGIN_TYPE)[number];

export const DATA_CLASSIFICATION = ['public', 'personal', 'sensitive', 'secret'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATION)[number];

export const TRUST_LEVEL = ['user_provided', 'external_untrusted', 'agent_generated', 'system_generated'] as const;
export type TrustLevel = (typeof TRUST_LEVEL)[number];

export const PLUGIN_KIND = ['agent-adapter', 'tool', 'domain-pack', 'skill-pack'] as const;
export type PluginKind = (typeof PLUGIN_KIND)[number];

export const PLUGIN_SOURCE = ['builtin', 'reviewed', 'user-local'] as const;
export type PluginSource = (typeof PLUGIN_SOURCE)[number];

export const INSTALL_STATE = ['inspected', 'trusted', 'enabled', 'disabled', 'revoked'] as const;
export type InstallState = (typeof INSTALL_STATE)[number];

export const STEP_KIND = ['note', 'agent-delegate', 'verify', 'approval', 'human-input'] as const;
export type StepKind = (typeof STEP_KIND)[number];

export const CAPABILITY = [
  'fs.read.workspace',
  'fs.write.workspace',
  'process.exec',
  'network.egress.allowed_hosts',
  'external.send',
  'credentials.use',
] as const;
export type Capability = (typeof CAPABILITY)[number];

export const CONTRACT_VERSION = '1.1' as const;
export const RESULT_VERSION = '1.1' as const;

/** paos:// schema id whitelist pattern - no arbitrary URLs (SSRF defence). */
export const SCHEMA_ID_PATTERN = /^paos:\/\/schemas\/[a-z0-9-]+\/\d+\.\d+\.\d+$/;
