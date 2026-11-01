// The bundled SQLite in this environment is 3.51.2; lower the runtime gate so
// the test suite can open the DB. Mirrors the existing runtime/db test setup.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '@paos/db';
import { seedDemoCockpit } from '../src/demo-seed.js';
import { buildCockpitApp } from '../src/auth.js';
import { startCockpit } from '../src/server.js';
import type { CockpitServer } from '../src/server.js';

const SECRET = 'test-secret-' + 'a'.repeat(32);
let dataDir: string;

// Fake CLIs used to exercise the spawn path without touching real state.
let fakeOk: string;
let fakeSlow: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'paos-actions-'));
  const db = openDatabase(join(dataDir, 'paos.db'));
  migrate(db);
  seedDemoCockpit(db);
  db.close();

  const fakeDir = mkdtempSync(join(tmpdir(), 'paos-actions-fake-'));
  fakeOk = join(fakeDir, 'ok.mjs');
  writeFileSync(
    fakeOk,
    'process.stdout.write(JSON.stringify({ args: process.argv.slice(2) }));\nprocess.exit(0);\n',
  );
  fakeSlow = join(fakeDir, 'slow.mjs');
  writeFileSync(fakeSlow, 'setTimeout(() => process.exit(0), 2500);\n');
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(join(tmpdir(), 'paos-actions-fake-'), { recursive: true, force: true });
});

function authHeaders(body?: unknown): Record<string, string> {
  const h: Record<string, string> = { host: '127.0.0.1', authorization: `Bearer ${SECRET}` };
  if (body !== undefined) h['content-type'] = 'application/json';
  return h;
}

describe('cockpit actions: auth + validation', () => {
  let app: ReturnType<typeof buildCockpitApp>;
  // Build the app inside beforeAll so `dataDir` (assigned there) is already set;
  // building at describe-collection time would capture an undefined dataDir.
  beforeAll(() => {
    app = buildCockpitApp({ dataDir, secret: SECRET, cliEntry: fakeOk });
  });

  it('401 without a bearer token', async () => {
    const res = await app.request('http://127.0.0.1/api/actions/deny', {
      method: 'POST',
      headers: { host: '127.0.0.1' },
      body: JSON.stringify({ approvalId: 'a1' }),
    });
    expect(res.status).toBe(401);
  });

  it('400 when approvalId is missing or empty', async () => {
    const res = await app.request('http://127.0.0.1/api/actions/deny', {
      method: 'POST',
      headers: authHeaders({ approvalId: '' }),
      body: JSON.stringify({ approvalId: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('502 when the approval id fails the argv guard (no spawn of a bad id)', async () => {
    const res = await app.request('http://127.0.0.1/api/actions/deny', {
      method: 'POST',
      headers: authHeaders({ approvalId: 'x y' }),
      body: JSON.stringify({ approvalId: 'x y' }),
    });
    expect(res.status).toBe(502);
  });

  it('200 spawns the CLI to record a denial', async () => {
    const res = await app.request('http://127.0.0.1/api/actions/deny', {
      method: 'POST',
      headers: authHeaders({ approvalId: 'a1' }),
      body: JSON.stringify({ approvalId: 'a1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decision: string; output: string };
    expect(body.ok).toBe(true);
    expect(body.decision).toBe('denied');
    expect(body.output).toContain('--deny');
    expect(body.output).toContain('--by');
    expect(body.output).toContain('cockpit');
    // The spawned CLI must be pinned to the server's dataDir (it defaults to a
    // relative `data` otherwise, which would approve against the wrong DB).
    const spawnedArgs = JSON.parse(body.output).args as string[];
    const ddIdx = spawnedArgs.indexOf('--data-dir');
    expect(ddIdx).toBeGreaterThan(-1);
    expect(spawnedArgs[ddIdx + 1]).toBe(dataDir);
  });

  it('approve is intentionally not wired (Option A gate)', async () => {
    const res = await app.request('http://127.0.0.1/api/actions/approve', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ approvalId: 'a1' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { cliCommand: string };
    expect(body.cliCommand).toContain('paos approve');
  });
});

describe('cockpit actions: OD2 dispatch isolation', () => {
  // While a child process is in flight, the HTTP server must still answer reads.
  let server: CockpitServer | undefined;

  it('serves GET /api/snapshot while the deny child is running', async () => {
    server = await startCockpit({ dataDir, secret: SECRET, cliEntry: fakeSlow, port: 0 });
    const deny = fetch(`${server.url}/api/actions/deny`, {
      method: 'POST',
      headers: authHeaders({ approvalId: 'a1' }),
      body: JSON.stringify({ approvalId: 'a1' }),
    });
    // The child sleeps 2.5s; the server must answer a concurrent read immediately.
    const snap = await fetch(`${server.url}/api/snapshot`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(snap.status).toBe(200);
    const result = (await deny) as Response;
    expect(result.status).toBe(200);
  });

  afterAll(async () => {
    await server?.close();
  });
});
