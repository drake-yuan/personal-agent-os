// The bundled SQLite in this environment is 3.51.2; lower the runtime gate so
// the test suite can open the DB. Mirrors the existing runtime/db test setup.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  insertTask,
  insertWorkflowRun,
  insertApproval,
  insertDispatchIntent,
  type TaskInsert,
} from '@paos/db';
import { buildCockpitSnapshot, renderDashboardHtml, cmdDashboard } from '../src/dashboard.js';

function seed(db: ReturnType<typeof openDatabase>): void {
  const now = new Date().toISOString();
  const task: TaskInsert = {
    id: 'T-1',
    domain: 'eng',
    title: 'Ship the cockpit',
    nextAction: 'write html',
    doneCondition: 'renders',
    status: 'done',
    risk: 'R2',
    evidenceRefs: ['e1'],
    createdAt: now,
    updatedAt: now,
  };
  insertTask(db, task);
  insertWorkflowRun(db, {
    id: 'WR-1',
    workflowId: 'wf-cockpit',
    workflowVersion: '1',
    domain: 'eng',
    taskId: 'T-1',
    status: 'succeeded',
    codeVersion: 'abc123',
    inputRef: 'input-1',
    createdAt: now,
    updatedAt: now,
  });
  insertApproval(db, {
    id: 'A-1',
    workflowRunId: 'WR-1',
    stepId: 'S-1',
    risk: 'R4',
    action: 'send_money',
    actionHash: 'h1',
    resourceScopeHash: 'r1',
    decision: 'pending',
    createdAt: now,
    updatedAt: now,
  });
  insertDispatchIntent(db, {
    id: 'D-1',
    workflowRunId: 'WR-1',
    stepId: 'S-1',
    adapterId: 'codex-adapter',
    provider: 'codex',
    idempotencyKey: 'k1',
    contractHash: 'c1',
    state: 'reconciled',
    supportsServerIdempotency: false,
    createdAt: now,
    updatedAt: now,
  });
}

describe('buildCockpitSnapshot', () => {
  it('empty DB yields zeroed summary and empty collections', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const snap = buildCockpitSnapshot(db, 'memory');
    expect(snap.summary.taskCount).toBe(0);
    expect(snap.summary.pendingApprovalCount).toBe(0);
    expect(snap.summary.dispatchCount).toBe(0);
    expect(snap.tasks).toEqual([]);
    db.close();
  });

  it('reflects seeded rows in summary and collections', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    seed(db);
    const snap = buildCockpitSnapshot(db, 'memory');
    expect(snap.summary.taskCount).toBe(1);
    expect(snap.summary.pendingApprovalCount).toBe(1);
    expect(snap.summary.dispatchCount).toBe(1);
    expect(snap.summary.tasksByStatus.done).toBe(1);
    expect(snap.summary.tasksByRisk.R2).toBe(1);
    expect(snap.summary.dispatchByState.reconciled).toBe(1);
    expect(snap.tasks[0]?.id).toBe('T-1');
    expect(snap.approvals[0]?.id).toBe('A-1');
    expect(snap.dispatchIntents[0]?.provider).toBe('codex');
    db.close();
  });
});

describe('renderDashboardHtml', () => {
  it('renders empty-state placeholders', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const snap = buildCockpitSnapshot(db, 'memory');
    const html = renderDashboardHtml(snap);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('no tasks');
    expect(html).toContain('no pending approvals');
    expect(html).toContain('read-only');
    db.close();
  });

  it('renders seeded data into tables and inlines JSON safely', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    seed(db);
    const snap = buildCockpitSnapshot(db, 'memory');
    const html = renderDashboardHtml(snap);
    expect(html).toContain('Ship the cockpit');
    expect(html).toContain('A-1');
    expect(html).toContain('codex');
    // The inline JSON must be present and parseable-ish marker exists.
    expect(html).toContain('id="snapshot"');
    db.close();
  });

  it('escapes HTML/script injection from DB content', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = new Date().toISOString();
    insertTask(db, {
      id: 'T-x',
      domain: 'eng',
      title: '</script><img src=x onerror=alert(1)>',
      nextAction: 'x',
      doneCondition: 'x',
      status: 'inbox',
      risk: 'R0',
      createdAt: now,
      updatedAt: now,
    });
    const snap = buildCockpitSnapshot(db, 'memory');
    const html = renderDashboardHtml(snap);
    // The raw injection string must NOT survive into the document.
    expect(html).not.toContain('</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    db.close();
  });
});

describe('cmdDashboard', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'paos-dash-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a self-contained HTML file from a DB on disk', () => {
    const dbPath = join(dir, 'paos.db');
    const db = openDatabase(dbPath);
    migrate(db);
    seed(db);
    db.close();

    const out = join(dir, 'cockpit.html');
    const msg = cmdDashboard(dir, out);
    expect(msg).toContain('dashboard written');
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Ship the cockpit');
  });

  it('returns a not-initialized hint when the DB is absent', () => {
    const out = join(dir, 'cockpit.html');
    const msg = cmdDashboard(dir, out);
    expect(msg).toContain('not initialized');
    expect(existsSync(out)).toBe(false);
  });
});
