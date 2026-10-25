/**
 * Unified adapter interface (design Section 10.1).
 *
 * The interface is split so that adapters can only ever report
 * observations: probe / plan / dispatch / stream / cancel / reconcile /
 * mapResult. There is deliberately no `completeTask` method - task
 * acceptance belongs to the Verifier.
 */
import type { DispatchIntent } from '@paos/runtime';

export interface AdapterHealth {
  installed: boolean;
  authenticated: boolean;
  /** declared vs enforced, exactly as probed */
  declaredCapabilities: string[];
  enforcedCapabilities: string[];
  enforcedIsolation: 'none' | 'workspace-fs' | 'container';
  unconfined: boolean;
  liveConnectivity: boolean;
  /** max silent interval in ms; heartbeat threshold derives from this */
  maxSilentMs: number;
  supportsServerIdempotency: boolean; // measured, not declared
  diagnostics: Array<{ code: string; message: string; nextStep?: string }>;
}

export interface DispatchPlan {
  provider: string;
  command: string[]; // argv array - never an unsanitised shell string
  cwd: string;
  env: Record<string, string>;
  estimatedMaxSilentMs: number;
}

export interface DispatchOutcome {
  providerTaskId?: string;
  transport: 'ok' | 'timeout' | 'connection_error' | 'protocol_error';
  error?: string;
}

export interface RunEvent {
  at: string;
  eventType: string;
  stepId?: string;
  detail: string;
}

export interface CancelOutcome {
  local: 'stopped';
  remote: 'confirmed' | 'unconfirmed' | 'unsupported';
}

export interface ProviderObservation {
  providerTaskId: string;
  providerStatus: string;
  transport: 'ok' | 'timeout' | 'connection_error' | 'protocol_error';
}

/** Vendor raw output - shape is provider-specific, always untrusted. */
export interface VendorRaw {
  provider: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  payload?: unknown;
}

export interface AgentAdapter {
  readonly id: string;
  readonly provider: string;
  probe(): Promise<AdapterHealth>;
  plan(input: { contract: unknown; workspace: string }): Promise<DispatchPlan>;
  dispatch(intent: DispatchIntent, ctx: { plan: DispatchPlan }): Promise<DispatchOutcome>;
  stream(runId: string): AsyncIterable<RunEvent>;
  cancel(runId: string): Promise<CancelOutcome>;
  reconcile(providerTaskId: string): Promise<ProviderObservation>;
  /** Observations only - never `accepted`. */
  mapResult(raw: VendorRaw): unknown;
}
