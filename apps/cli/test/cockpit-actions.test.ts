// The bundled SQLite in this environment is 3.51.2; lower the runtime gate so
// the test suite can open the DB. Mirrors the existing runtime/db test setup.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, migrate } from '@paos/db';
import { seedDemoCockpit } from '../src/demo-seed.js';
import { buildCockpitApp } from '../src/auth.js';
import { startCockpit } from '../src/server.js';
import type { CockpitServer } from '../src/server.js';

const SECRET = 'test-secret-' + 'a'.repeat(32);
let dataDir: string;
// Module-scoped handle: kept open for the whole suite so downstream tests can
// read/seed state (the 409 and end-to-end approve tests both touch the DB).
let db: DatabaseSync;

// Fake CLIs used to exercise the spawn path without touching real state.
let fakeOk: string;
let fakeSlow: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'paos-actions-'));
  db = openDatabase(join(dataDir, 'paos.db'));
  migrate(db);
  seedDemoCockpit(db);

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
  db.close();
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

  it('approve resolves the frozen contract hash from input_ref and spawns the CLI', async () => {
    const res = await app.request('http://127.0.0.1/api/actions/approve', {
      method: 'POST',
      headers: authHeaders({ approvalId: 'DEMO-A-02', token: 'x' }),
      body: JSON.stringify({ approvalId: 'DEMO-A-02', token: 'x' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; decision: string; contractHash: string; output: string };
    expect(body.ok).toBe(true);
    expect(body.decision).toBe('approved');
    // The fake CLI echoed its argv; confirm the route passed --contract-hash with
    // the hash it resolved from the run's input_ref, plus --data-dir pinning.
    const spawned = JSON.parse(body.output).args as string[];
    expect(spawned).toContain('approve');
    expect(spawned).toContain('DEMO-A-02');
    const hIdx = spawned.indexOf('--contract-hash');
    expect(hIdx).toBeGreaterThan(-1);
    expect(spawned[hIdx + 1]).toBe(body.contractHash);
    expect(spawned).toContain('--data-dir');
    expect(spawned[spawned.indexOf('--data-dir') + 1]).toBe(dataDir);
  });

  it('approve returns 409 with a fallback cliCommand for a run with no frozen contract', async () => {
    // A synthetic approval on a run whose input_ref is not `contract:<hash>`.
    // (run_contracts is keyed solely by run_id, so we must use a fresh run id -
    // a second row for an already-frozen run would violate the primary key.)
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_id, workflow_version, domain, task_id, status, code_version, input_ref, created_at, updated_at) VALUES ('WR-NOPE','wf','1','eng','DEMO-T-01','waiting_approval','v','not-a-contract',?,?)",
    ).run(ts, ts);
    db.prepare(
      "INSERT INTO approvals (id, workflow_run_id, step_id, risk, action, action_hash, resource_scope_hash, decision, created_at, updated_at) VALUES ('APR-NOPE','WR-NOPE','S-1','R3','x','h','r','pending',?,?)",
    ).run(ts, ts);
    const res = await app.request('http://127.0.0.1/api/actions/approve', {
      method: 'POST',
      headers: authHeaders({ approvalId: 'APR-NOPE' }),
      body: JSON.stringify({ approvalId: 'APR-NOPE' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { cliCommand: string };
    expect(body.cliCommand).toContain('paos approve');
  });
});

describe('cockpit actions: approve end-to-end (real CLI child)', () => {
  // Drives the real built CLI as the child, proving the whole chain:
  // route reads input_ref -> spawns `paos approve --contract-hash` -> decision lands.
  let realApp: ReturnType<typeof buildCockpitApp>;
  let realCli: string;
  beforeAll(() => {
    realCli = join(fileURLToPath(import.meta.url), '..', '..', 'dist', 'index.js');
    realApp = buildCockpitApp({ dataDir, secret: SECRET, cliEntry: realCli });
  });

  it('approves an R4 approval through the cockpit and records the decision', async () => {
    const res = await realApp.request('http://127.0.0.1/api/actions/approve', {
      method: 'POST',
      headers: authHeaders({ approvalId: 'DEMO-A-01', token: 'T-e2e' }),
      body: JSON.stringify({ approvalId: 'DEMO-A-01', token: 'T-e2e' }),
    });
    expect(res.status).toBe(200);
    const decided = db
      .prepare('SELECT decision FROM approvals WHERE id = ?')
      .get('DEMO-A-01') as { decision: string };
    // The cockpit approve resumes the run (default adapter), so the approval is
    // consumed exactly once at dispatch start - the stored decision is 'consumed',
    // while the human-facing decision returned in the response is 'approved'.
    expect(decided.decision).toBe('consumed');
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
