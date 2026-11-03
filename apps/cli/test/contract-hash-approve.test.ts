// Use the documented SQLite gate escape hatch (test runtime 3.51.2).
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '@paos/db';
import type { DatabaseSync } from 'node:sqlite';
import { cmdInit, cmdApprove, type ParsedArgs } from '../src/index.js';
import { seedDemoCockpit } from '../src/demo-seed.js';

let dataDir: string;
let db: DatabaseSync;

function approveArgs(approvalId: string, flags: Record<string, string | boolean>): ParsedArgs {
  return { command: 'approve', positional: [approvalId], flags };
}

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'paos-chash-'));
  cmdInit(dataDir);
  db = openDatabase(join(dataDir, 'paos.db'));
  migrate(db);
  seedDemoCockpit(db);
  // A dedicated approval whose task sits in `waiting_approval` so the deny
  // transition (task -> blocked) is legal - the demo seed's approval tasks are
  // all in terminal states, which would reject the transition.
  const ts = new Date().toISOString();
  db.prepare(
    "INSERT INTO tasks (id, domain, title, next_action, done_condition, status, risk, evidence_refs, created_at, updated_at) VALUES ('T-DENY','eng','deny test','x','x','waiting_approval','R1','[]',?,?)",
  ).run(ts, ts);
  db.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, workflow_version, domain, task_id, status, code_version, input_ref, created_at, updated_at) VALUES ('WR-DENY','wf','1','eng','T-DENY','waiting_approval','v','contract:deny-x',?,?)",
  ).run(ts, ts);
  db.prepare(
    "INSERT INTO approvals (id, workflow_run_id, step_id, risk, action, action_hash, resource_scope_hash, decision, created_at, updated_at) VALUES ('APR-DENY','WR-DENY','S-1','R1','x','h','r','pending',?,?)",
  ).run(ts, ts);
});

afterAll(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function frozenHash(runId: string): string {
  const row = db.prepare('SELECT contract_hash FROM run_contracts WHERE run_id = ?').get(runId) as
    | { contract_hash: string }
    | undefined;
  if (!row) throw new Error(`no frozen contract for ${runId}`);
  return row.contract_hash;
}

describe('ADR-005: cmdApprove --contract-hash', () => {
  it('approves an R4 approval via the frozen contract (parity with --contract <file>)', async () => {
    const hash = frozenHash('DEMO-WR-04');
    const out = await cmdApprove(
      approveArgs('DEMO-A-01', {
        'data-dir': dataDir,
        'contract-hash': hash,
        token: 'T-test',
        by: 'cockpit',
      }),
    );
    expect(out).toContain('approval DEMO-A-01: approved');
    // With a contract (and thus a default adapter) supplied, the approval resumes
    // the run and is consumed exactly once at dispatch start (T14) - so the stored
    // decision is 'consumed', not 'approved'. The human-facing decision is still
    // 'approved' (visible in `out`).
    const apr = db.prepare('SELECT decision FROM approvals WHERE id = ?').get('DEMO-A-01') as {
      decision: string;
    };
    expect(apr.decision).toBe('consumed');
  });

  it('rejects when no frozen contract matches the given hash', async () => {
    const out = await cmdApprove(
      approveArgs('DEMO-A-01', { 'data-dir': dataDir, 'contract-hash': 'deadbeef'.repeat(8), by: 'cockpit' }),
    );
    expect(out).toMatch(/no frozen contract/i);
  });

  it('rejects when the stored contract no longer validates against the current schema', async () => {
    // A frozen copy whose contract_json is corrupt: it must fail cleanly at
    // approval time (JSON.parse / schema re-validation) rather than throw. Uses a
    // fresh run id because run_contracts is keyed solely by run_id (a second row
    // for an already-frozen run would violate the primary key).
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_id, workflow_version, domain, task_id, status, code_version, input_ref, created_at, updated_at) VALUES ('WR-BAD','wf','1','eng','DEMO-T-01','waiting_approval','v',?,?,?)",
    ).run('contract:badhashbadhash', ts, ts);
    db.prepare(
      "INSERT INTO approvals (id, workflow_run_id, step_id, risk, action, action_hash, resource_scope_hash, decision, created_at, updated_at) VALUES ('APR-BAD','WR-BAD','S-1','R3','x','h','r','pending',?,?)",
    ).run(ts, ts);
    db.prepare(
      'INSERT INTO run_contracts (run_id, contract_hash, contract_json, created_at) VALUES (?, ?, ?, ?)',
    ).run('WR-BAD', 'badhashbadhash', '{ this is not a contract }', ts);
    const out = await cmdApprove(
      approveArgs('APR-BAD', { 'data-dir': dataDir, 'contract-hash': 'badhashbadhash', by: 'cockpit' }),
    );
    expect(out).toMatch(/no longer validates/i);
  });

  it('deny still works without a contract (unchanged behaviour)', async () => {
    const out = await cmdApprove(
      approveArgs('APR-DENY', { 'data-dir': dataDir, deny: true, by: 'cockpit' }),
    );
    expect(out).toContain('approval APR-DENY: denied');
  });
});
