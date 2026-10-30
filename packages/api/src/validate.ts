/**
 * Runtime validation of the cockpit DTO. The live service already serves a JSON
 * contract (GET /api/snapshot); this guard runs at the serialization boundary so
 * a schema drift in the builder or an unexpected row shape fails closed (500)
 * instead of shipping a half-broken payload that the polling client tries to
 * render. It is the ADR-004 "hand-copied-drift" defense at the wire edge.
 */
import type { CockpitSnapshot, CockpitSummary } from './types.js';
import { COCKPIT_DISTRIBUTION_ENUMS } from './constants.js';

export class DriftError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`cockpit DTO drift detected: ${issues.join('; ')}`);
    this.name = 'DriftError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNumberMap(v: unknown): v is Record<string, number> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every(isFiniteNumber);
}

export function validateCockpitSummary(v: unknown): CockpitSummary {
  if (!isPlainObject(v)) throw new DriftError(['summary is not an object']);
  const issues: string[] = [];
  if (!isString(v.sqliteVersion)) issues.push('summary.sqliteVersion must be a string');
  if (!isFiniteNumber(v.taskCount)) issues.push('summary.taskCount must be a number');
  if (!isFiniteNumber(v.runCount)) issues.push('summary.runCount must be a number');
  if (!isFiniteNumber(v.pendingApprovalCount)) {
    issues.push('summary.pendingApprovalCount must be a number');
  }
  if (!isFiniteNumber(v.dispatchCount)) issues.push('summary.dispatchCount must be a number');
  for (const field of Object.keys(COCKPIT_DISTRIBUTION_ENUMS)) {
    if (!isNumberMap(v[field])) {
      issues.push(`summary.${field} must be a {string:number} map`);
    }
  }
  if (issues.length > 0) throw new DriftError(issues);
  return v as unknown as CockpitSummary;
}

export function validateCockpitSnapshot(v: unknown): CockpitSnapshot {
  if (!isPlainObject(v)) throw new DriftError(['snapshot is not an object']);
  const issues: string[] = [];
  const generatedAt = v.generatedAt;
  const dataDir = v.dataDir;
  if (!isString(generatedAt)) issues.push('generatedAt must be a string');
  if (!isString(dataDir)) issues.push('dataDir must be a string');
  if (!Array.isArray(v.tasks)) issues.push('tasks must be an array');
  if (!Array.isArray(v.workflowRuns)) issues.push('workflowRuns must be an array');
  if (!Array.isArray(v.dispatchIntents)) issues.push('dispatchIntents must be an array');
  if (!Array.isArray(v.approvals)) issues.push('approvals must be an array');
  if (!isPlainObject(v.summary)) issues.push('summary must be an object');
  if (issues.length > 0) throw new DriftError(issues);
  const summary = validateCockpitSummary(v.summary);
  return {
    generatedAt: generatedAt as string,
    dataDir: dataDir as string,
    summary,
    tasks: v.tasks as CockpitSnapshot['tasks'],
    workflowRuns: v.workflowRuns as CockpitSnapshot['workflowRuns'],
    dispatchIntents: v.dispatchIntents as CockpitSnapshot['dispatchIntents'],
    approvals: v.approvals as CockpitSnapshot['approvals'],
  };
}
