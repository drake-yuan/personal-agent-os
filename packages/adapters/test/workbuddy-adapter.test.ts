/**
 * WorkBuddy adapter tests: the adapter must be structured enough to route to,
 * and must fail closed until gate G3 supplies real credentials.
 *
 * Every network call is mocked - these tests never touch the network and
 * never need real credentials.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type { DispatchIntent } from '@paos/runtime';
import {
  WorkBuddyAdapter, workBuddyConfigFromEnv,
  type HttpFetch, type HttpRequestInit, type HttpResponse,
} from '../src/workbuddy-adapter.js';

const ENV_KEYS = [
  'PAOS_WORKBUDDY_ENDPOINT', 'PAOS_WORKBUDDY_TOKEN',
  'PAOS_WORKBUDDY_CLIENT_ID', 'PAOS_WORKBUDDY_CLIENT_SECRET',
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function json(status: number, body: unknown): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Record every call and return per-path responses. */
function mockFetch(
  routes: Record<string, HttpResponse | ((init: HttpRequestInit) => HttpResponse)>,
): { fetchImpl: HttpFetch; calls: Array<{ url: string; init: HttpRequestInit }> } {
  const calls: Array<{ url: string; init: HttpRequestInit }> = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return json(404, { error: 'no route' });
    return typeof route === 'function' ? route(init) : route;
  };
  return { fetchImpl, calls };
}

function configured(
  overrides: { endpoint?: string; token?: string; fetchImpl?: HttpFetch } = {},
): WorkBuddyAdapter {
  return new WorkBuddyAdapter({
    endpoint: overrides.endpoint ?? 'https://wb.example.com',
    token: overrides.token ?? 'test-token',
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
}

function contractHash(contract: unknown): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

describe('WorkBuddyAdapter', () => {
  it('is unconfigured and fails closed without endpoint and token', async () => {
    const adapter = new WorkBuddyAdapter();
    const health = await adapter.probe();
    expect(health.installed).toBe(false);
    expect(health.authenticated).toBe(false);
    // Fail closed: nothing enforced, so no hard decision can lean on it.
    expect(health.enforcedCapabilities).toEqual([]);
    expect(health.unconfined).toBe(true);
    expect(health.diagnostics[0]?.code).toBe('E_WORKBUDDY_NOT_CONFIGURED');

    const outcome = await adapter.dispatch(
      { contractHash: 'x' } as unknown as DispatchIntent,
      { plan: await adapter.plan({ contract: {}, workspace: '/w' }) },
    );
    expect(outcome.transport).toBe('connection_error');
    expect((await adapter.reconcile('workbuddy-1')).providerStatus).toBe('unknown');
    expect((await adapter.cancel('workbuddy-1')).remote).toBe('unconfirmed');
  });

  it('requires BOTH endpoint and token - one alone is not configured', async () => {
    const noToken = new WorkBuddyAdapter({ endpoint: 'https://wb.example.com' });
    expect((await noToken.probe()).authenticated).toBe(false);
    const noEndpoint = new WorkBuddyAdapter({ token: 't' });
    expect((await noEndpoint.probe()).authenticated).toBe(false);
  });

  it('probes authenticated and reports only genuinely enforced capabilities', async () => {
    const { fetchImpl, calls } = mockFetch({ 'https://wb.example.com/v1/account': json(200, { ok: true }) });
    const health = await configured({ fetchImpl }).probe();
    expect(health.installed).toBe(true);
    expect(health.authenticated).toBe(true);
    // Remote executor: structured output + outbound only. Local fs is
    // declared but never enforced.
    expect(health.enforcedCapabilities).toEqual(['structured_output', 'external.send']);
    expect(health.declaredCapabilities).toContain('fs.read.workspace');
    expect(health.enforcedIsolation).toBe('container');
    expect(health.unconfined).toBe(false);
    // The token travels as a bearer header, never in the URL.
    expect(calls[0]?.init.headers.authorization).toBe('Bearer test-token');
    expect(calls[0]?.url).not.toContain('test-token');
  });

  it('reports a rejected credential as unauthenticated, not as a crash', async () => {
    const { fetchImpl } = mockFetch({ 'https://wb.example.com/v1/account': json(401, {}) });
    const health = await configured({ fetchImpl }).probe();
    expect(health.authenticated).toBe(false);
    expect(health.enforcedCapabilities).toEqual([]);
    expect(health.diagnostics[0]?.code).toBe('E_WORKBUDDY_AUTH');
  });

  it('reports an unreachable endpoint as offline without retrying', async () => {
    const fetchImpl: HttpFetch = async () => { throw new Error('ENOTFOUND'); };
    const health = await configured({ fetchImpl }).probe();
    expect(health.installed).toBe(true);
    expect(health.liveConnectivity).toBe(false);
    expect(health.authenticated).toBe(false);
    expect(health.diagnostics[0]?.code).toBe('E_WORKBUDDY_UNREACHABLE');
  });

  it('dispatches a task and reconciles its status (no process exit code)', async () => {
    const { fetchImpl, calls } = mockFetch({
      'https://wb.example.com/v1/account': json(200, {}),
      'https://wb.example.com/v1/tasks': json(201, { id: 't-42' }),
      'https://wb.example.com/v1/tasks/t-42': json(200, { status: 'COMPLETED' }),
    });
    const adapter = configured({ fetchImpl });
    const contract = { objective: 'draft the summary' };
    // The objective reaches the request BODY, never the URL or argv.
    const plan = await adapter.plan({ contract, workspace: '/ws' });
    const outcome = await adapter.dispatch(
      { contractHash: contractHash(contract) } as unknown as DispatchIntent,
      { plan },
    );
    expect(outcome.transport).toBe('ok');
    expect(outcome.providerTaskId).toBe('workbuddy-t-42');
    const post = calls.find((c) => c.url.endsWith('/v1/tasks') && c.init.method === 'POST');
    expect(post?.init.body).toContain('draft the summary');
    expect(JSON.parse(post?.init.body ?? '{}').mode).toBe('non-interactive');

    const observation = await adapter.reconcile('workbuddy-t-42');
    // Status is lowercased so it matches the runtime provider status map.
    expect(observation.providerStatus).toBe('completed');
    expect(observation.transport).toBe('ok');
    // null = "no process exists", distinct from undefined = unobservable.
    expect(observation.exitCode).toBeNull();
  });

  it('maps transport failures without inventing a task failure', async () => {
    const { fetchImpl } = mockFetch({
      'https://wb.example.com/v1/tasks': json(500, {}),
    });
    const adapter = configured({ fetchImpl });
    const plan = await adapter.plan({ contract: { objective: 'x' }, workspace: '/ws' });
    const outcome = await adapter.dispatch(
      { contractHash: contractHash({ objective: 'x' }) } as unknown as DispatchIntent,
      { plan },
    );
    expect(outcome.transport).toBe('protocol_error');

    const offline: HttpFetch = async () => { throw new Error('ECONNREFUSED'); };
    const out2 = await configured({ fetchImpl: offline }).dispatch(
      { contractHash: 'h' } as unknown as DispatchIntent,
      { plan },
    );
    expect(out2.transport).toBe('connection_error');
  });

  it('treats an unrecognised status as unknown, never failed', async () => {
    const { fetchImpl } = mockFetch({ 'https://wb.example.com/v1/tasks/t-1': json(200, {}) });
    const observation = await configured({ fetchImpl }).reconcile('workbuddy-t-1');
    expect(observation.providerStatus).toBe('unknown');
  });

  it('confirms a remote cancel only when the provider confirms it', async () => {
    const { fetchImpl } = mockFetch({ 'https://wb.example.com/v1/tasks/t-7/cancel': json(200, {}) });
    expect((await configured({ fetchImpl }).cancel('workbuddy-t-7')).remote).toBe('confirmed');
    const { fetchImpl: bad } = mockFetch({ 'https://wb.example.com/v1/tasks/t-7/cancel': json(500, {}) });
    expect((await configured({ fetchImpl: bad }).cancel('workbuddy-t-7')).remote).toBe('unconfirmed');
  });

  it('streams a start/status/exit sequence', async () => {
    const { fetchImpl } = mockFetch({ 'https://wb.example.com/v1/tasks/t-9': json(200, { status: 'working' }) });
    const events = [];
    for await (const e of configured({ fetchImpl }).stream('workbuddy-t-9')) events.push(e.eventType);
    expect(events).toEqual(['workbuddy.start', 'workbuddy.status', 'workbuddy.exit']);
  });

  it('mapResult reports an observation, never an acceptance', async () => {
    const mapped = configured().mapResult({
      provider: 'workbuddy',
      payload: { id: 't-3', status: 'completed' },
    }) as Record<string, unknown>;
    expect(mapped.provider).toBe('workbuddy');
    expect(mapped.provider_status).toBe('completed');
    expect(mapped).not.toHaveProperty('accepted');
  });

  it('reads configuration from the environment, ignoring blank values', () => {
    expect(workBuddyConfigFromEnv({})).toEqual({});
    process.env.PAOS_WORKBUDDY_ENDPOINT = 'https://wb.example.com';
    process.env.PAOS_WORKBUDDY_TOKEN = '  ';
    expect(workBuddyConfigFromEnv().endpoint).toBe('https://wb.example.com');
    expect(workBuddyConfigFromEnv().token).toBeUndefined();
  });
});
