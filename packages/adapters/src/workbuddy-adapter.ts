/**
 * WorkBuddy cloud adapter (design Section 10.1, gate G3).
 *
 * WorkBuddy is a REMOTE agent, not a local binary: it cannot be spawned, so
 * `BaseCliAdapter` (stdin + argv) does not apply here. This adapter drives it
 * over HTTP with a bearer token while keeping the identical observation-only
 * contract - it never writes task state.
 *
 * Four rules, mirroring the CLI adapters:
 *  - No host is invented. There is no default endpoint: if
 *    `PAOS_WORKBUDDY_ENDPOINT` is unset the adapter is simply not configured,
 *    and `probe()` says so instead of guessing a URL that would fail later.
 *  - Missing or rejected credentials fail closed: `authenticated` stays false,
 *    enforced capabilities go empty and `unconfined` becomes true, so the
 *    Router cannot hand it scope-restricted work.
 *  - Enforced capabilities are only what a remote executor genuinely
 *    guarantees. WorkBuddy runs in its own environment and has NO local
 *    filesystem access, so `fs.*` is declared but NOT enforced - contracts
 *    needing it are correctly refused rather than silently attempted.
 *  - A transport failure is never a task failure: network errors map to
 *    `connection_error` / `timeout`, and an unrecognised provider status stays
 *    `unknown`, never `failed` (see runtime/src/status-map.ts).
 *
 * Gate status: G3 (OAuth app review) is NOT passed, so this adapter is
 * selectable and fully structured but cannot complete a real dispatch until
 * an endpoint and token are supplied and the app review closes.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentAdapter, AdapterHealth, DispatchOutcome, DispatchPlan,
  ProviderObservation, RunEvent, VendorRaw, CancelOutcome,
} from './types.js';
import type { DispatchIntent } from '@paos/runtime';

/** Minimal response surface the adapter needs; satisfied by `fetch`. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type HttpFetch = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export interface WorkBuddyConfig {
  /** Base URL, e.g. `https://api.example.com`. No default is assumed. */
  endpoint?: string;
  /** OAuth bearer token. Absent -> adapter is unconfigured, fails closed. */
  token?: string;
  clientId?: string;
  clientSecret?: string;
  /** Cap on a single dispatch. Over budget -> timeout -> unknown_outcome. */
  timeoutMs?: number;
  /** Injectable transport; defaults to global `fetch`. */
  fetchImpl?: HttpFetch;
}

export const WORKBUDDY_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const TASK_PREFIX = 'workbuddy-';

/**
 * Read WorkBuddy settings from the environment. Blank values are treated as
 * unset so an empty `.env` variable cannot look like configuration.
 */
export function workBuddyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<WorkBuddyConfig, 'endpoint' | 'token' | 'clientId' | 'clientSecret'> {
  const endpoint = env.PAOS_WORKBUDDY_ENDPOINT?.trim();
  const token = env.PAOS_WORKBUDDY_TOKEN?.trim();
  const clientId = env.PAOS_WORKBUDDY_CLIENT_ID?.trim();
  const clientSecret = env.PAOS_WORKBUDDY_CLIENT_SECRET?.trim();
  return {
    ...(endpoint ? { endpoint } : {}),
    ...(token ? { token } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Contracts arrive as `unknown`; only the objective is ever read. */
function objectiveOf(contract: unknown): string {
  const objective = (contract as { objective?: unknown })?.objective;
  return typeof objective === 'string' ? objective : '';
}

/** Pull an identifier out of an untrusted vendor payload. */
function extractId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const rec = payload as Record<string, unknown>;
  for (const key of ['id', 'task_id', 'run_id']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Pull the raw provider status out of an untrusted vendor payload. */
function extractStatus(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const rec = payload as Record<string, unknown>;
  for (const key of ['status', 'state']) {
    const v = rec[key];
    if (typeof v === 'string' && v.length > 0) return v.toLowerCase();
  }
  return undefined;
}

function stripPrefix(providerTaskId: string): string {
  return providerTaskId.startsWith(TASK_PREFIX)
    ? providerTaskId.slice(TASK_PREFIX.length)
    : providerTaskId;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class WorkBuddyAdapter implements AgentAdapter {
  readonly id = 'workbuddy-adapter';
  readonly provider = 'workbuddy';

  private readonly endpoint?: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: HttpFetch;
  /** Prompt keyed by contract hash, exactly as the CLI adapters do. */
  private readonly prompts = new Map<string, string>();
  private readonly observations = new Map<string, string>();

  constructor(opts: WorkBuddyConfig = {}) {
    const env = workBuddyConfigFromEnv();
    this.endpoint = opts.endpoint ?? env.endpoint;
    this.token = opts.token ?? env.token;
    this.timeoutMs = opts.timeoutMs ?? WORKBUDDY_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);
  }

  /** Configured means: an endpoint AND a token. One alone is not enough. */
  private get configured(): boolean {
    return this.endpoint !== undefined && this.token !== undefined;
  }

  private url(suffix: string): string {
    return `${(this.endpoint ?? '').replace(/\/+$/, '')}${suffix}`;
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /**
   * Declared vs enforced. Declared is what the provider advertises; enforced
   * is what this OS can actually rely on. A remote executor guarantees
   * structured output and outbound sends - and nothing about the local disk.
   */
  private profile(): {
    declared: string[];
    enforced: string[];
    isolation: AdapterHealth['enforcedIsolation'];
    unconfined: boolean;
  } {
    return {
      declared: ['fs.read.workspace', 'fs.write.workspace', 'structured_output', 'external.send'],
      enforced: ['structured_output', 'external.send'],
      isolation: 'container', // runs in the provider's own sandbox, not here
      unconfined: false,
    };
  }

  private health(input: {
    installed: boolean;
    authenticated?: boolean;
    live?: boolean;
    diagnostics: AdapterHealth['diagnostics'];
  }): AdapterHealth {
    const profile = this.profile();
    const installed = input.installed;
    // Fail closed: an unauthenticated remote executor is credited with
    // nothing, so no hard security decision can lean on it.
    const proven = installed && (input.authenticated ?? false);
    return {
      installed,
      authenticated: input.authenticated ?? false,
      declaredCapabilities: profile.declared,
      enforcedCapabilities: proven ? profile.enforced : [],
      enforcedIsolation: proven ? profile.isolation : 'none',
      unconfined: proven ? profile.unconfined : true,
      liveConnectivity: input.live ?? installed,
      maxSilentMs: installed ? this.timeoutMs : 0,
      // Not measured against a live server, so it is not claimed.
      supportsServerIdempotency: false,
      diagnostics: input.diagnostics,
    };
  }

  async probe(): Promise<AdapterHealth> {
    if (!this.configured) {
      const missing: string[] = [];
      if (!this.endpoint) missing.push('PAOS_WORKBUDDY_ENDPOINT');
      if (!this.token) missing.push('PAOS_WORKBUDDY_TOKEN');
      return this.health({
        installed: false,
        authenticated: false,
        live: false,
        diagnostics: [{
          code: 'E_WORKBUDDY_NOT_CONFIGURED',
          message: `WorkBuddy adapter is not configured: missing ${missing.join(', ')}`,
          nextStep: 'set the WorkBuddy endpoint and OAuth token (gate G3: OAuth app review pending); `handoff` mode is the documented fallback',
        }],
      });
    }

    let res: HttpResponse | undefined;
    let error: string | undefined;
    try {
      res = await this.fetchImpl(this.url('/v1/account'), {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      error = messageOf(err);
    }

    if (res === undefined) {
      return this.health({
        installed: true,
        authenticated: false,
        live: false,
        diagnostics: [{
          code: 'E_WORKBUDDY_UNREACHABLE',
          message: `cannot reach ${this.endpoint}: ${error ?? 'unknown error'}`,
          nextStep: 'check network and endpoint; the adapter stays paused, no retry storm',
        }],
      });
    }
    if (res.status === 401 || res.status === 403) {
      return this.health({
        installed: true,
        authenticated: false,
        diagnostics: [{
          code: 'E_WORKBUDDY_AUTH',
          message: `WorkBuddy rejected the credential (HTTP ${res.status})`,
          nextStep: 'refresh the OAuth token; closing this needs the G3 gate',
        }],
      });
    }
    if (!res.ok) {
      return this.health({
        installed: true,
        authenticated: false,
        diagnostics: [{
          code: 'E_WORKBUDDY_PROBE_FAILED',
          message: `WorkBuddy probe returned HTTP ${res.status}`,
          nextStep: 'verify the endpoint path matches the WorkBuddy API',
        }],
      });
    }
    return this.health({ installed: true, authenticated: true, diagnostics: [] });
  }

  async plan(input: { contract: unknown; workspace: string }): Promise<DispatchPlan> {
    this.prompts.set(sha256(JSON.stringify(input.contract)), objectiveOf(input.contract));
    return {
      provider: this.provider,
      // A remote adapter has no argv. The request it will make is recorded
      // here so the dispatch intent stays inspectable.
      command: ['POST', this.url('/v1/tasks')],
      cwd: input.workspace,
      env: {},
      estimatedMaxSilentMs: this.timeoutMs,
    };
  }

  async dispatch(intent: DispatchIntent, ctx: { plan: DispatchPlan }): Promise<DispatchOutcome> {
    if (!this.configured) {
      return {
        transport: 'connection_error',
        error: 'WorkBuddy adapter is not configured (need PAOS_WORKBUDDY_ENDPOINT and PAOS_WORKBUDDY_TOKEN)',
      };
    }
    const body = JSON.stringify({
      objective: this.prompts.get(intent.contractHash) ?? '',
      workspace: ctx.plan.cwd,
      contract_hash: intent.contractHash,
      // Unattended by design: the OS never asks a remote agent to escalate.
      mode: 'non-interactive',
    });
    let res: HttpResponse;
    try {
      res = await this.fetchImpl(this.url('/v1/tasks'), {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { transport: 'connection_error', error: messageOf(err) };
    }
    if (!res.ok) {
      return { transport: 'protocol_error', error: `WorkBuddy returned HTTP ${res.status}` };
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { transport: 'protocol_error', error: 'WorkBuddy returned a non-JSON response' };
    }
    const remoteId = extractId(payload);
    if (remoteId === undefined) {
      return { transport: 'protocol_error', error: 'WorkBuddy response carried no task id' };
    }
    const providerTaskId = `${TASK_PREFIX}${remoteId}`;
    this.observations.set(providerTaskId, 'creating');
    return { transport: 'ok', providerTaskId };
  }

  async *stream(runId: string): AsyncIterable<RunEvent> {
    const at = new Date().toISOString();
    yield { at, eventType: 'workbuddy.start', detail: `run ${runId}` };
    const observation = await this.reconcile(runId);
    yield {
      at,
      eventType: 'workbuddy.status',
      detail: `status=${observation.providerStatus} transport=${observation.transport}`,
    };
    yield {
      at,
      eventType: 'workbuddy.exit',
      // Honest: a remote agent has no process, so no exit code exists.
      detail: 'remote executor: no process exit code',
    };
  }

  async cancel(runId: string): Promise<CancelOutcome> {
    if (!this.configured) {
      // Nothing was started remotely, so nothing can be confirmed stopped.
      return { local: 'stopped', remote: 'unconfirmed' };
    }
    try {
      const res = await this.fetchImpl(
        this.url(`/v1/tasks/${encodeURIComponent(stripPrefix(runId))}/cancel`),
        { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
      return { local: 'stopped', remote: res.ok ? 'confirmed' : 'unconfirmed' };
    } catch {
      return { local: 'stopped', remote: 'unconfirmed' };
    }
  }

  async reconcile(providerTaskId: string): Promise<ProviderObservation> {
    if (!this.configured) {
      return { providerTaskId, providerStatus: 'unknown', transport: 'connection_error' };
    }
    let res: HttpResponse;
    try {
      res = await this.fetchImpl(
        this.url(`/v1/tasks/${encodeURIComponent(stripPrefix(providerTaskId))}`),
        { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );
    } catch {
      return { providerTaskId, providerStatus: 'unknown', transport: 'connection_error' };
    }
    if (!res.ok) {
      // Unknown, never `failed`: an unreadable status is not evidence of failure.
      return { providerTaskId, providerStatus: 'unknown', transport: 'protocol_error' };
    }
    const payload = await res.json().catch(() => undefined);
    const status = extractStatus(payload);
    if (status !== undefined) this.observations.set(providerTaskId, status);
    return {
      providerTaskId,
      providerStatus: status ?? 'unknown',
      transport: 'ok',
      // `null` = "there is no process to exit", distinct from `undefined`
      // ("not observable"), which must fail verification closed.
      exitCode: null,
    };
  }

  /** Observation only - evidence for the Verifier, never a verdict. */
  mapResult(raw: VendorRaw): unknown {
    const payload = raw.payload as Record<string, unknown> | undefined;
    const status = typeof payload?.status === 'string' ? payload.status : 'unknown';
    const remoteId = extractId(payload) ?? randomUUID();
    return {
      result_version: '1.1',
      provider: this.provider,
      provider_status: status,
      transport_status: raw.exitCode === undefined ? 'unknown' : 'ok',
      native_run: { run_id: `${TASK_PREFIX}${remoteId}`, exit_code: null },
      raw_result_ref: raw.stdout ? `sha256:${sha256(raw.stdout)}` : undefined,
      artifacts: [],
      usage: { duration_s: null, tokens: null, cost_usd: null, cost_source: 'unknown' },
      errors: raw.stderr ? [{ code: 'stderr', message: raw.stderr.slice(0, 1000) }] : [],
    };
  }
}
