import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The bundled node:sqlite ships SQLite 3.51.2, just below the 3.51.3
// WAL-reset gate. Tests exercise the gate logic itself; the override
// documents the explicit escape hatch (design Section 6.3 rule 6).
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';

const { openDatabase, sqliteVersion, compareVersions, migrate, appliedVersions, backupDatabase } = await import('../src/index.js');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'paos-db-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies the v2 baseline to an empty DB', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const result = migrate(db);
    expect(result.applied).toEqual([1]);
    expect(result.skipped).toEqual([]);
    expect(appliedVersions(db)).toEqual([1]);
    db.close();
  });

  it('re-running is idempotent (skips, no error)', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const result = migrate(db);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([1]);
    db.close();
  });

  it('creates all 22 baseline tables', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      'schema_migrations', 'installation', 'domain_packs', 'plugin_registry', 'adapter_capabilities',
      'goals', 'profiles', 'profile_facts', 'projects', 'tasks', 'task_dependencies', 'decisions', 'conflicts',
      'workflow_runs', 'run_steps', 'dispatch_intents', 'run_events', 'approvals', 'audit_events',
      'artifacts', 'evidence', 'claims', 'evidence_claim_links', 'memories', 'eval_runs',
    ]) {
      expect(tables, t).toContain(t);
    }
    db.close();
  });

  it('WAL and foreign_keys are enabled', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    db.close();
  });

  it('CHECK constraints enforce the v2 enums', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id, domain, title, next_action, done_condition, status, risk, created_at, updated_at)
                VALUES ('t1','work','x','y','z','inbox','R0',?,?)`).run(now, now);
    expect(() =>
      db.prepare(`INSERT INTO tasks (id, domain, title, next_action, done_condition, status, risk, created_at, updated_at)
                  VALUES ('t2','work','x','y','z','bogus_status','R0',?,?)`).run(now, now),
    ).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO tasks (id, domain, title, next_action, done_condition, status, risk, created_at, updated_at)
                  VALUES ('t3','work','x','y','z','inbox','R9',?,?)`).run(now, now),
    ).toThrow();
    db.close();
  });

  it('audit_events is append-only (triggers reject UPDATE and DELETE)', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO audit_events (at, actor, action, decision) VALUES (?,?,?,?)`)
      .run(now, 'test', 'test.action', 'allowed');
    expect(() =>
      db.prepare(`UPDATE audit_events SET decision = 'tampered' WHERE id = 1`).run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare(`DELETE FROM audit_events WHERE id = 1`).run(),
    ).toThrow(/append-only/);
    db.close();
  });

  it('dispatch_intents enforces idempotency_key uniqueness', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO workflow_runs (id, workflow_id, workflow_version, domain, status, code_version, input_ref, created_at, updated_at)
                VALUES ('w1','software-change','1.0.0','work','planned','0.2.0','ref',?,?)`).run(now, now);
    const insert = () => db.prepare(`INSERT INTO dispatch_intents (id, workflow_run_id, step_id, adapter_id, provider, idempotency_key, contract_hash, state, created_at, updated_at)
                VALUES (?, 'w1','s1','demo','demo','dup-key','hash','pending',?,?)`);
    insert().run('d1', now, now);
    expect(() => insert().run('d2', now, now)).toThrow();
    db.close();
  });

  it('foreign keys are enforced (run_steps requires a workflow_run)', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const now = new Date().toISOString();
    expect(() =>
      db.prepare(`INSERT INTO run_steps (workflow_run_id, step_id, seq, kind, status) VALUES ('nope','s1',1,'note','pending')`).run(),
    ).toThrow();
    db.close();
  });

  it('backup via VACUUM INTO produces a re-openable DB', () => {
    const db = openDatabase(path.join(dir, 'a.db'));
    const backupPath = path.join(dir, 'backups', 'a-backup.db');
    backupDatabase(db, backupPath);
    const backup = openDatabase(backupPath);
    expect(appliedVersions(backup)).toEqual([1]);
    backup.close();
    db.close();
  });
});

describe('sqlite version gate (P1-02)', () => {
  it('reports the bundled version', () => {
    const db = openDatabase(':memory:');
    expect(sqliteVersion(db)).toMatch(/^\d+\.\d+\.\d+$/);
    db.close();
  });

  it('compareVersions orders dotted versions', () => {
    expect(compareVersions('3.51.3', '3.51.2')).toBe(1);
    expect(compareVersions('3.51.2', '3.51.3')).toBe(-1);
    expect(compareVersions('3.51.3', '3.51.3')).toBe(0);
    expect(compareVersions('3.52.0', '3.51.99')).toBe(1);
    expect(compareVersions('4.0.0', '3.99.99')).toBe(1);
  });

  it('refuses to open below the gate', async () => {
    process.env.PAOS_MIN_SQLITE_VERSION = '99.0.0';
    try {
      expect(() => openDatabase(':memory:')).toThrow(/below the required/);
    } finally {
      process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
    }
  });
});
