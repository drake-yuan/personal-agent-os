/**
 * Cockpit HTTP auth baseline (Alt.1 P0).
 *
 * A Hono middleware that enforces, in order:
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
  type CockpitSnapshot,
} from './dashboard.js';
import { loadInstallationSecret, tokenMatches } from './secret.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_MAX_BODY = 64 * 1024;

export interface CockpitAuthConfig {
  secret: string;
  /** Max request body in bytes; requests above this are rejected with 400. */
  maxBodyBytes?: number;
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
  const maxBody = config.maxBodyBytes ?? DEFAULT_MAX_BODY;
  return async (c: Context, next: () => Promise<void>) => {
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
}

/** Build the Hono app for the cockpit service (authenticated, read-only). */
export function buildCockpitApp(deps: CockpitAppDeps): Hono {
  const app = new Hono();
  app.use('*', cockpitAuth({ secret: deps.secret, maxBodyBytes: deps.maxBodyBytes }));

  app.get('/api/snapshot', (c) => {
    const snap = serveSnapshot(c, deps.dataDir);
    if (snap instanceof Response) return snap;
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

  return app;
}

// Re-exported so the server bootstrap and tests can resolve the secret without
// reaching into the file system directly.
export { loadInstallationSecret };
