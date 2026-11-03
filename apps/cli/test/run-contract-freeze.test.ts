// The bundled SQLite in this environment is 3.51.2; lower the runtime gate so
// the test suite can open the DB. Mirrors the existing runtime/db test setup.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, getRunContract } from '@paos/db';
import type { DatabaseSync } from 'node:sqlite';
import { runContract } from '@paos/runtime';
import type { DispatchAdapter, ContractV11 } from '@paos/runtime';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Minimal adapter stub: never actually dispatches (the test parks at the R3 gate),
// but must satisfy the structural DispatchAdapter contract.
const stubAdapter: DispatchAdapter = {
  id: 'stub',
  provider: 'stub',
  async probe() {
    return {
      enforcedCapabilities: ['external.send'],
      unconfined: false,
      enforcedIsolation: 'workspace',
      supportsServerIdempotency: false,
    };
  },
  async plan() {
    return {};
  },
  async dispatch() {
    return { transport: 'none' };
  },
  async reconcile() {
    return { providerTaskId: '', providerStatus: 'unknown', transport: 'none' };
  },
};

function makeContract(workflowRunId: string): ContractV11 {
  return {
    contract_version: '1.1',
    task_id: `T-${workflowRunId}`,
    workflow_run_id: workflowRunId,
    step_id: 'S-1',
    objective: 'release_funds',
    domain: 'investing',
    workflow: { id: 'wf-fin', version: '2.0.0' },
    inputs: { workspace: '/tmp/ws', artifact_refs: [], trust_labels: ['system_generated'] },
    requirements: {
      required_capabilities: ['external.send'],
      scope_paths: ['/tmp/ws'],
      data_classification: 'public',
    },
    limits: {
      timeout_seconds: 300,
      max_steps: 10,
      max_tool_calls: 100,
      max_cost: { amount: null, currency: null, source: 'unknown' },
    },
    expected_output: {
      format: 'json',
      schema_id: 'paos://schemas/agent-result-contract/1.1.0',
      required_artifacts: ['result'],
    },
    acceptance: [{ id: 'ok', checker: 'verify.present', args: {} }],
    policy: { risk_level: 'R3', external_data_transfer: 'allow-public-only', approval_ref: null },
    idempotency: {
      dispatch_key: `${workflowRunId}-S-1-key`,
      delivery_semantics: 'at_least_once_with_reconciliation',
    },
  } as unknown as ContractV11;
}

describe('ADR-005: per-run frozen contract', () => {
  let db: DatabaseSync;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'paos-freeze-'));
    db = openDatabase(join(dataDir, 'paos.db'));
    migrate(db);
  });

  it('freezes a contract row when a run is created, with a self-consistent hash', async () => {
    const contract = makeContract('wfr-freeze-1');
    const result = await runContract({
      db,
      adapter: stubAdapter,
      contract,
      workspace: '/tmp/ws',
      actionType: 'external-send',
    });
    // R3 parks at the human gate before dispatch - run + freeze already happened.
    expect(result.runStatus).toBe('waiting_approval');
    expect(result.approvalId).toBeTruthy();

    const row = getRunContract(db, 'wfr-freeze-1');
    expect(row).toBeDefined();
    expect(row!.contract_hash).toBe(sha256(row!.contract_json));
    expect(JSON.parse(row!.contract_json).workflow_run_id).toBe('wfr-freeze-1');

    // The frozen hash must equal the digest embedded in the run's input_ref.
    const ref = db
      .prepare('SELECT input_ref FROM workflow_runs WHERE id = ?')
      .get('wfr-freeze-1') as { input_ref: string };
    const m = ref.input_ref.match(/^contract:(.+)$/);
    expect(m).toBeTruthy();
    expect(m![1]).toBe(row!.contract_hash);
  });

  it('does not double-freeze when the same run is replayed (idempotent run id)', async () => {
    const contract = makeContract('wfr-freeze-1');
    // Replaying the same contract (same workflow_run_id) must not crash on a
    // UNIQUE(run_id) and must not insert a second run_contracts row.
    await runContract({ db, adapter: stubAdapter, contract, workspace: '/tmp/ws', actionType: 'external-send' });
    const rows = db.prepare('SELECT * FROM run_contracts WHERE run_id = ?').all('wfr-freeze-1') as unknown[];
    expect(rows.length).toBe(1);
  });
});

describe('ADR-005: migration 0002 is idempotent', () => {
  it('applies once and is a no-op on re-run', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'paos-mig-'));
    const dbPath = join(dataDir, 'paos.db');
    const db = openDatabase(dbPath);
    const first = migrate(db);
    expect(first.applied).toContain(2);
    // Table exists.
    const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_contracts'").get();
    expect(tbl).toBeTruthy();
    const second = migrate(db);
    expect(second.applied).not.toContain(2);
    expect(second.skipped).toContain(2);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});
