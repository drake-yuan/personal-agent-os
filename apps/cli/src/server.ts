/**
 * Cockpit HTTP server bootstrap (Alt.1 P0 auth baseline).
 *
 * Binds 127.0.0.1 only and serves a read-only cockpit over Hono. Auth is
 * enforced by `cockpitAuth` (Host pin + cross-origin reject + bearer token);
 * the DB is opened read-only so the server can never write or corrupt state.
 * The CLI remains the sole writer - this process is purely a viewer.
 */
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { loadInstallationSecret } from './secret.js';
import { buildCockpitApp } from './auth.js';

export interface CockpitServerOptions {
  dataDir: string;
  host?: string;
  /** 0 (default) yields an ephemeral port assigned by the OS. */
  port?: number;
}

export interface CockpitServer {
  /** Resolved port (echoes the ephemeral port when options.port = 0). */
  port: number;
  /** Base URL for local clients, e.g. http://127.0.0.1:PORT. */
  url: string;
  close(): Promise<void>;
}

/**
 * Start the read-only cockpit server. Throws if `installation.secret` is absent
 * (the caller must run `paos init` first). The service is bound to loopback and
 * opens the DB read-only - it cannot mutate or corrupt the source of truth.
 *
 * Resolves only once the socket is actually listening, so callers can rely on
 * `url`/`port` being valid immediately upon resolution (no bind race).
 */
export async function startCockpit(opts: CockpitServerOptions): Promise<CockpitServer> {
  const host = opts.host ?? '127.0.0.1';
  const requestedPort = opts.port ?? 7070;
  const secret = loadInstallationSecret(opts.dataDir);
  const app = buildCockpitApp({ dataDir: opts.dataDir, secret });
  const server = serve({
    fetch: (req: Request) => app.fetch(req),
    port: requestedPort,
    hostname: host,
  });

  // Wait for the socket to be bound before resolving, so `port`/`url` are real.
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err) => reject(err));
  });

  const address = server.address();
  const port =
    address !== null && typeof address === 'object' ? (address as AddressInfo).port : requestedPort;

  return {
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
