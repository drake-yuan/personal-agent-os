/**
 * Cockpit HTTP auth baseline (Alt.1 P0).
 *
 * A Hono middleware that enforces, in order:
 *   0. Rate-limit - fixed-window cap (P0-3, defense-in-depth against token
 *      brute force); returns 429 with Retry-After once the budget is spent.
 *   1. Body-size ceiling - reject over-sized requests before reading the body.
 *   2. Host pinned to loopback - DNS-rebinding defense (the service binds
 *      127.0.0.1 only, but a browser can be tricked into sending a foreign
 *      Host, so we reject it explicitly).
 *   3. Cross-origin rejection - any non-loopback Origin is refused (CSRF-style
 *      cross-site reads from a malicious page are blocked).
 *   4. Bearer-token authentication against installation.secret (constant-time).
 *
 * The service is read-only and bound to loopback; these checks are defense in
 * depth so a misconfiguration cannot expose the data without the token.
 * `disabled` (demo mode) skips all guards for synthetic, throwaway preview data.
 */
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openReadonly } from '@paos/db';
import {
  buildCockpitSnapshot,
  renderCockpitInner,
  renderLiveCockpitHtml,
} from './dashboard.js';
import {
  validateCockpitSnapshot,
  DriftError,
  type CockpitSnapshot,
} from '@paos/api';
import { loadInstallationSecret, tokenMatches } from './secret.js';
import { denyApproval, approveApproval } from './actions.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_MAX_BODY = 64 * 1024;
// P0-3 (rate-limit): defense-in-depth against bearer-token brute force on the
// loopback surface. The limiter is global (single-user local service) rather
// than keyed by token - keying by token would let an attacker vary the token to
// bypass it. The poller hits ~12 req/min; this window is deliberately generous
// so legitimate bursts never trip it, while a flood is capped.
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_MAX = 300;

export interface FixedWindowOptions {
  windowMs: number;
  max: number;
  /** Injectable clock for deterministic tests; defaults to Date.now(). */
  now?: () => number;
}

export interface RateLimiter {
  /** Returns true if the request is allowed, false once the budget is spent. */
  allow(): boolean;
  /** Seconds until the current window resets (for the Retry-After header). */
  retryAfterSeconds(): number;
}

/**
 * A fixed-window counter. Not a token bucket - simplicity over smoothness; the
 * window is long (60s) and the cap generous, so the sawtooth at window edges is
 * irrelevant here. The only contract that matters: `allow()` returns false once
 * `max` requests land inside one window.
 */
export function createFixedWindowRateLimiter(opts: FixedWindowOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  let windowStart = now();
  let count = 0;
  return {
    allow() {
      const t = now();
      if (t - windowStart >= opts.windowMs) {
        windowStart = t;
        count = 0;
      }
      if (count >= opts.max) return false;
      count += 1;
      return true;
    },
    retryAfterSeconds() {
      const remaining = Math.ceil((windowStart + opts.windowMs - now()) / 1000);
      return remaining > 0 ? remaining : 1;
    },
  };
}

export interface CockpitAuthConfig {
  secret: string;
  /** Max request body in bytes; requests above this are rejected with 400. */
  maxBodyBytes?: number;
  /** Rate-limit budget; defaults to a generous 300 requests / 60s window. */
  rateLimit?: { windowMs: number; max: number };
  /**
   * Demo-only pass-through. When true, every guard is skipped. NEVER set this
   * for a real `dataDir` - the cockpit then serves without authentication. The
   * demo data is synthetic and the service stays loopback + read-only, so the
   * only thing skipped is the bearer check on throwaway preview data.
   */
  disabled?: boolean;
}

function normalizeHostHeader(raw: string | undefined): string | null {
  if (!raw) return null;
  const h = raw.toLowerCase();
  try {
    // URL parsing reliably splits host/port and unbrackets IPv6.
    // WHATWG URL keeps IPv6 in bracket form (e.g. "[::1]"), so strip them.
    return new URL(`http://${h}`).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    // Bare IPv6 literals (e.g. `::1`) are not URL-parseable without brackets.
    if (h.includes('::')) return h;
    const colon = h.lastIndexOf(':');
    return colon >= 0 ? h.slice(0, colon) : h;
  }
}

function hostIsLoopback(hostHeader: string | undefined): boolean {
  const host = normalizeHostHeader(hostHeader);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin => same-origin browser request or non-browser client
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

// Exported for unit testing: `fetch` cannot set the forbidden `Host` header, so
// the pinning logic is verified directly rather than through a live request.
export { hostIsLoopback, originIsLoopback };

export function cockpitAuth(config: CockpitAuthConfig): MiddlewareHandler {
  // Demo pass-through: skip all guards. Deliberately gated to synthetic data.
  if (config.disabled) return async (_c: Context, next: () => Promise<void>) => next();

  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const limiter = createFixedWindowRateLimiter(
    config.rateLimit ?? { windowMs: DEFAULT_RATE_WINDOW_MS, max: DEFAULT_RATE_MAX },
  );
  return async (c: Context, next: () => Promise<void>) => {
    // 0. Rate-limit (first, so a flood is throttled before any other check -
    //    it also covers the brute-force path against the bearer token).
    if (!limiter.allow()) {
      return c.json(
        { error: 'rate_limited' },
        429,
        { 'Retry-After': String(limiter.retryAfterSeconds()) },
      );
    }
    // 1. Body-size ceiling (header-only check; the body is never buffered).
    const contentLength = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > maxBody) {
      return c.json({ error: 'payload_too_large' }, 400);
    }
    // 2. Host pinned to loopback (DNS-rebinding defense).
    if (!hostIsLoopback(c.req.header('host'))) {
      return c.json({ error: 'forbidden_host' }, 403);
    }
    // 3. Cross-origin rejection.
    if (!originIsLoopback(c.req.header('origin'))) {
      return c.json({ error: 'cross_origin_rejected' }, 403);
    }
    // 4. Bearer-token authentication.
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    if (!tokenMatches(token, config.secret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };
}

/**
 * Read the snapshot from a read-only DB handle. Returns a 409 Response when the
 * DB is absent so the caller can short-circuit without building a snapshot.
 */
function serveSnapshot(c: Context, dataDir: string): CockpitSnapshot | Response {
  const dbPath = join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) {
    return c.json({ error: 'not_initialized', hint: 'run `paos init` first' }, 409);
  }
  const db = openReadonly(dbPath);
  try {
    return buildCockpitSnapshot(db, dataDir);
  } finally {
    db.close();
  }
}

export interface CockpitAppDeps {
  dataDir: string;
  secret: string;
  maxBodyBytes?: number;
  /** Rate-limit budget (P0-3); defaults to a generous 300 requests / 60s. */
  rateLimit?: { windowMs: number; max: number };
  /** Demo-only: skip authentication (synthetic data, loopback + read-only). */
  authless?: boolean;
  /** Override the CLI entry spawned for mutations (tests inject a fake binary). */
  cliEntry?: string;
}

/** Build the Hono app for the cockpit service (authenticated, read-only). */
export function buildCockpitApp(deps: CockpitAppDeps): Hono {
  const app = new Hono();
  app.use(
    '*',
    cockpitAuth({
      secret: deps.secret,
      maxBodyBytes: deps.maxBodyBytes,
      rateLimit: deps.rateLimit,
      disabled: deps.authless,
    }),
  );

  app.get('/api/snapshot', (c) => {
    const snap = serveSnapshot(c, deps.dataDir);
    if (snap instanceof Response) return snap;
    // Drift guard at the wire boundary: fail closed (500) if the built snapshot
    // no longer matches the declared DTO, rather than serving a broken payload
    // that the polling client would try to render.
    try {
      validateCockpitSnapshot(snap);
    } catch (err) {
      if (err instanceof DriftError) {
        return c.json({ error: 'snapshot_drift', issues: err.issues }, 500);
      }
      throw err;
    }
    return c.json(snap);
  });

  // HTML fragment used by the live page's polling client. Same auth as every
  // other route; returns only the visual body so the client can swap it cheaply.
  app.get('/api/cockpit', (c) => {
    const snap = serveSnapshot(c, deps.dataDir);
    if (snap instanceof Response) return snap;
    return c.html(renderCockpitInner(snap));
  });

  // Live, authenticated HTML cockpit - read-only body plus a zero-dependency
  // polling client (see renderLiveCockpitHtml) that re-fetches /api/cockpit.
  app.get('/', (c) => {
    const snap = serveSnapshot(c, deps.dataDir);
    if (snap instanceof Response) return snap;
    return c.html(renderLiveCockpitHtml(snap, deps.secret));
  });

  /**
   * Mutation surface (ADR-004 P1-2). Every write is executed by spawning the
   * existing, fully-tested CLI as a child process - the server stays read-only
   * and never blocks its own event loop (OD2). `deny` needs no contract and is
   * the least-privileged decision; `approve` (ADR-005) resolves the frozen
   * contract by hash and delegates the mutation to the CLI, so the server still
   * never holds the write lock or imports `runContract`.
   */
  app.post('/api/actions/deny', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const approvalId =
      body && typeof body === 'object' && 'approvalId' in body
        ? (body as { approvalId?: unknown }).approvalId
        : undefined;
    if (typeof approvalId !== 'string' || approvalId.length === 0) {
      return c.json({ error: 'bad_request', detail: 'approvalId required' }, 400);
    }
    const result = await denyApproval({
      dataDir: deps.dataDir,
      approvalId,
      cliEntry: deps.cliEntry,
    });
    if (!result.ok) {
      return c.json(
        { error: 'action_failed', exitCode: result.code, stderr: result.stderr.trim() },
        502,
      );
    }
    return c.json({ ok: true, decision: 'denied', output: result.stdout.trim() });
  });

  /**
   * Approve a pending approval (ADR-005). The server reads `input_ref` for the
   * approval's run (a read-only SELECT) to resolve the frozen-contract hash, then
   * spawns `paos approve <id> --contract-hash <hash>`. The contract body is never
   * read by the server; the child re-validates it against the current schema and
   * performs the write. Runs frozen before ADR-005 have no `run_contracts` row, so
   * we return a 409 with a fallback `cliCommand` instructing the operator to
   * supply the contract file.
   */
  app.post('/api/actions/approve', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const approvalId =
      body && typeof body === 'object' && 'approvalId' in body
        ? (body as { approvalId?: unknown }).approvalId
        : undefined;
    if (typeof approvalId !== 'string' || approvalId.length === 0) {
      return c.json({ error: 'bad_request', detail: 'approvalId required' }, 400);
    }
    const token =
      body && typeof body === 'object' && 'token' in body && typeof (body as { token?: unknown }).token === 'string'
        ? (body as { token: string }).token
        : undefined;

    const dbPath = join(deps.dataDir, 'paos.db');
    if (!existsSync(dbPath)) {
      return c.json({ error: 'not_initialized', hint: 'run `paos init` first' }, 409);
    }
    const db = openReadonly(dbPath);
    try {
      const apr = db
        .prepare('SELECT workflow_run_id FROM approvals WHERE id = ?')
        .get(approvalId) as { workflow_run_id: string } | undefined;
      if (!apr) return c.json({ error: 'approval_not_found' }, 404);
      const run = db
        .prepare('SELECT input_ref FROM workflow_runs WHERE id = ?')
        .get(apr.workflow_run_id) as { input_ref: string } | undefined;
      const m = run?.input_ref?.match(/^contract:(.+)$/);
      if (!m) {
        return c.json(
          {
            error: 'contract_unresolvable',
            detail: 'run has no frozen contract (created before ADR-005).',
            cliCommand: `paos approve ${approvalId} --contract <path> [--token T] [--by NAME]`,
          },
          409,
        );
      }
      const contractHash = m[1] as string;
      const result = await approveApproval({
        dataDir: deps.dataDir,
        approvalId,
        contractHash,
        decidedBy: 'cockpit',
        token,
        cliEntry: deps.cliEntry,
      });
      if (!result.ok) {
        return c.json(
          { error: 'action_failed', exitCode: result.code, stderr: result.stderr.trim() },
          502,
        );
      }
      return c.json({ ok: true, decision: 'approved', contractHash, output: result.stdout.trim() });
    } finally {
      db.close();
    }
  });

  return app;
}

// Re-exported so the server bootstrap and tests can resolve the secret without
// reaching into the file system directly.
export { loadInstallationSecret };
