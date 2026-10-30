/**
 * Web cockpit v0.2 - Alt.0 static dashboard (see docs/adr/ADR-004).
 *
 * A self-contained HTML file with the DB snapshot inlined. No server, no
 * fetch, no external resources - open it from disk (file://) and it renders.
 * This is the read-only cockpit: it visualizes task state, the human approval
 * queue, dispatch intents (real agent runs) and workflow runs. It performs no
 * writes and is safe to hand to anyone who can read the DB.
 */
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { TASK_STATUS, RISK_LEVEL } from '@paos/contracts';
import {
  openDatabase,
  sqliteVersion,
  pendingApprovals,
  type TaskRow,
  type WorkflowRunRow,
  type DispatchIntentRow,
  type ApprovalRow,
} from '@paos/db';

export interface CockpitSummary {
  sqliteVersion: string;
  taskCount: number;
  runCount: number;
  pendingApprovalCount: number;
  dispatchCount: number;
  tasksByStatus: Record<string, number>;
  tasksByRisk: Record<string, number>;
  runsByStatus: Record<string, number>;
  dispatchByState: Record<string, number>;
}

export interface CockpitSnapshot {
  generatedAt: string;
  dataDir: string;
  summary: CockpitSummary;
  tasks: TaskRow[];
  workflowRuns: WorkflowRunRow[];
  dispatchIntents: DispatchIntentRow[];
  approvals: ApprovalRow[];
}

/**
 * Single read pass over the DB. Shared by `paos status --json` and the static
 * dashboard so the two can never report divergent numbers. Callers open the DB
 * however they like; this function only runs SELECTs.
 */
export function buildCockpitSnapshot(db: DatabaseSync, dataDir: string): CockpitSnapshot {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as unknown as TaskRow[];
  const workflowRuns = db
    .prepare('SELECT * FROM workflow_runs ORDER BY updated_at DESC')
    .all() as unknown as WorkflowRunRow[];
  const dispatchIntents = db
    .prepare('SELECT * FROM dispatch_intents ORDER BY updated_at DESC')
    .all() as unknown as DispatchIntentRow[];
  const approvals = pendingApprovals(db);

  const tasksByStatus: Record<string, number> = {};
  for (const s of TASK_STATUS) tasksByStatus[s] = 0;
  for (const t of tasks) tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;

  const tasksByRisk: Record<string, number> = {};
  for (const r of RISK_LEVEL) tasksByRisk[r] = 0;
  for (const t of tasks) tasksByRisk[t.risk] = (tasksByRisk[t.risk] ?? 0) + 1;

  const runsByStatus: Record<string, number> = {};
  for (const r of workflowRuns) runsByStatus[r.status] = (runsByStatus[r.status] ?? 0) + 1;

  const dispatchByState: Record<string, number> = {};
  for (const d of dispatchIntents) {
    dispatchByState[d.state] = (dispatchByState[d.state] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    dataDir,
    summary: {
      sqliteVersion: sqliteVersion(db),
      taskCount: tasks.length,
      runCount: workflowRuns.length,
      pendingApprovalCount: approvals.length,
      dispatchCount: dispatchIntents.length,
      tasksByStatus,
      tasksByRisk,
      runsByStatus,
      dispatchByState,
    },
    tasks,
    workflowRuns,
    dispatchIntents,
    approvals,
  };
}

// ----------------------------------------------------------------------------
// HTML rendering (server-side; the file is fully static once written)
// ----------------------------------------------------------------------------

/** Escape for safe interpolation into HTML text/attribute context. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_COLOR: Record<string, string> = {
  done: '#22c55e',
  rejected: '#ef4444',
  cancelled: '#9ca3af',
  running: '#3b82f6',
  waiting_approval: '#f59e0b',
  review_required: '#a855f7',
  blocked: '#ef4444',
  failed: '#dc2626',
  inbox: '#64748b',
  triaged: '#0ea5e9',
  planned: '#6366f1',
  ready: '#14b8a6',
  deferred: '#f97316',
  cancel_requested: '#f43f5e',
};

const RISK_COLOR: Record<string, string> = {
  R0: '#9ca3af',
  R1: '#3b82f6',
  R2: '#14b8a6',
  R3: '#f59e0b',
  R4: '#ef4444',
};

const DISPATCH_COLOR: Record<string, string> = {
  reconciled: '#22c55e',
  pending: '#f59e0b',
  failed: '#dc2626',
  unknown_outcome: '#a855f7',
};

function chip(label: string, color: string, kind = 'chip'): string {
  return `<span class="${kind}" style="--c:${color}">${esc(label)}</span>`;
}

function statusChip(status: string): string {
  return chip(status, STATUS_COLOR[status] ?? '#64748b');
}

function riskChip(risk: string): string {
  return chip(risk, RISK_COLOR[risk] ?? '#64748b');
}

/** Horizontal bars for a { label: count } distribution. */
function distributionRows(dist: Record<string, number>): string {
  const max = Math.max(1, ...Object.values(dist));
  return Object.entries(dist)
    .map(([label, n]) => {
      const pct = Math.round((n / max) * 100);
      return (
        `<div class="bar-row">` +
        `<span class="bar-label">${esc(label)}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>` +
        `<span class="bar-num">${n}</span>` +
        `</div>`
      );
    })
    .join('');
}

function taskRows(tasks: TaskRow[]): string {
  if (tasks.length === 0) return '<tr><td colspan="6" class="empty">no tasks</td></tr>';
  return tasks
    .map(
      (t) => `<tr>
        <td class="mono small">${esc(t.id)}</td>
        <td>${statusChip(t.status)}</td>
        <td>${riskChip(t.risk)}</td>
        <td>${esc(t.title)}</td>
        <td>${esc(t.domain)}</td>
        <td class="mono small">${esc(t.updated_at)}</td>
      </tr>`,
    )
    .join('');
}

function runRows(runs: WorkflowRunRow[]): string {
  if (runs.length === 0) return '<tr><td colspan="6" class="empty">no workflow runs</td></tr>';
  return runs
    .map(
      (r) => `<tr>
        <td class="mono small">${esc(r.id)}</td>
        <td>${statusChip(r.status)}</td>
        <td>${esc(r.domain)}</td>
        <td class="mono small">${esc(r.workflow_id)}</td>
        <td class="mono small">${esc(r.task_id ?? '')}</td>
        <td class="mono small">${esc(r.updated_at)}</td>
      </tr>`,
    )
    .join('');
}

function dispatchRows(items: DispatchIntentRow[]): string {
  if (items.length === 0) return '<tr><td colspan="6" class="empty">no dispatch intents</td></tr>';
  return items
    .map((d) => {
      const state = d.state;
      return `<tr>
        <td class="mono small">${esc(d.id)}</td>
        <td>${chip(d.provider, DISPATCH_COLOR[state] ?? '#64748b', 'chip')}</td>
        <td>${chip(state, DISPATCH_COLOR[state] ?? '#64748b', 'chip')}</td>
        <td class="mono small">${esc(d.provider_task_id ?? '-')}</td>
        <td class="mono small">${esc(d.adapter_id)}</td>
        <td class="mono small">${esc(d.attempt_count)}</td>
      </tr>`;
    })
    .join('');
}

function approvalRows(approvals: ApprovalRow[]): string {
  if (approvals.length === 0) return '<tr><td colspan="5" class="empty">no pending approvals 🎉</td></tr>';
  return approvals
    .map(
      (a) => `<tr class="approval-row">
        <td class="mono small">${esc(a.id)}</td>
        <td>${riskChip(a.risk)}</td>
        <td>${esc(a.action)}</td>
        <td class="mono small">${esc(a.workflow_run_id)}</td>
        <td class="mono small">${esc(a.step_id)}</td>
      </tr>`,
    )
    .join('');
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg); color: var(--text);
}
:root {
  --bg: #ffffff; --panel: #f6f7f9; --border: #e2e5ea; --text: #1a1d21;
  --muted: #6b7280; --accent: #2563eb; --track: #e9ecf1; --card: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #272d36; --text: #e6edf3;
    --muted: #8b949e; --accent: #4f9cff; --track: #21262d; --card: #11161d;
  }
}
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
  background: var(--panel); border: 1px solid var(--border); color: var(--muted); margin-left: 8px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.card .n { font-size: 26px; font-weight: 700; }
.card .l { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 20px; }
section h2 { font-size: 15px; margin: 0 0 14px; }
section h2 .count { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 8px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
.bar-row { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.bar-label { width: 150px; font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; background: var(--track); border-radius: 4px; height: 12px; overflow: hidden; }
.bar-fill { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
.bar-num { width: 28px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
td.empty { color: var(--muted); text-align: center; padding: 18px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.small { font-size: 11px; color: var(--muted); }
.chip { display: inline-block; padding: 1px 8px; border-radius: 6px; font-size: 12px;
  border-left: 3px solid var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
.approval-row td { background: color-mix(in srgb, #f59e0b 8%, transparent); }
footer { color: var(--muted); font-size: 11px; margin-top: 8px; }
`;

/**
 * Render the snapshot into a self-contained HTML document. The JSON is inlined
 * for developer access (escaped so a `</script>` inside data cannot break out).
 */
export function renderDashboardHtml(snap: CockpitSnapshot): string {
  const s = snap.summary;
  const dataJson = JSON.stringify(snap).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PAOS Cockpit</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Personal Agent OS · Cockpit <span class="badge">read-only</span></h1>
<div class="sub">generated ${esc(snap.generatedAt)} · sqlite ${esc(s.sqliteVersion)} · data-dir ${esc(snap.dataDir)}</div>

<div class="cards">
  <div class="card"><div class="n">${s.taskCount}</div><div class="l">tasks</div></div>
  <div class="card"><div class="n">${s.runCount}</div><div class="l">workflow runs</div></div>
  <div class="card"><div class="n">${s.pendingApprovalCount}</div><div class="l">pending approvals</div></div>
  <div class="card"><div class="n">${s.dispatchCount}</div><div class="l">dispatch intents</div></div>
</div>

<section>
  <h2>Task status</h2>
  <div class="grid2">
    <div>${distributionRows(s.tasksByStatus)}</div>
    <div>
      <h2 style="font-size:13px;margin:0 0 10px;color:var(--muted)">Risk level</h2>
      ${distributionRows(s.tasksByRisk)}
    </div>
  </div>
</section>

<section>
  <h2>Workflow runs <span class="count">${s.runCount}</span></h2>
  <div class="grid2">
    <div>${distributionRows(s.runsByStatus)}</div>
    <div>
      <h2 style="font-size:13px;margin:0 0 10px;color:var(--muted)">Dispatch state</h2>
      ${distributionRows(s.dispatchByState)}
    </div>
  </div>
</section>

<section>
  <h2>Pending approvals <span class="count">${s.pendingApprovalCount}</span> · human gate</h2>
  <table>
    <thead><tr><th>id</th><th>risk</th><th>action</th><th>run</th><th>step</th></tr></thead>
    <tbody>${approvalRows(snap.approvals)}</tbody>
  </table>
</section>

<section>
  <h2>Tasks <span class="count">${s.taskCount}</span></h2>
  <table>
    <thead><tr><th>id</th><th>status</th><th>risk</th><th>title</th><th>domain</th><th>updated</th></tr></thead>
    <tbody>${taskRows(snap.tasks)}</tbody>
  </table>
</section>

<section>
  <h2>Workflow runs <span class="count">${s.runCount}</span></h2>
  <table>
    <thead><tr><th>id</th><th>status</th><th>domain</th><th>workflow</th><th>task</th><th>updated</th></tr></thead>
    <tbody>${runRows(snap.workflowRuns)}</tbody>
  </table>
</section>

<section>
  <h2>Dispatch intents <span class="count">${s.dispatchCount}</span></h2>
  <table>
    <thead><tr><th>id</th><th>provider</th><th>state</th><th>provider task</th><th>adapter</th><th>attempts</th></tr></thead>
    <tbody>${dispatchRows(snap.dispatchIntents)}</tbody>
  </table>
</section>

<footer>PAOS v0.2 static cockpit — generated locally, no network, no server. Source of truth remains the SQLite DB.</footer>
<script id="snapshot" type="application/json">${dataJson}</script>
</body>
</html>`;
}

/**
 * `paos dashboard [--out FILE]` - render the cockpit to a self-contained HTML
 * file (default <dataDir>/dashboard.html). Read-only: it only reads the DB.
 */
export function cmdDashboard(dataDir: string, outPath?: string): string {
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) return 'not initialized - run `paos init` first';
  const out = outPath ? path.resolve(outPath) : path.join(path.resolve(dataDir), 'dashboard.html');
  mkdirSync(path.dirname(out), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    const snap = buildCockpitSnapshot(db, dataDir);
    writeFileSync(out, renderDashboardHtml(snap), 'utf8');
    return `dashboard written: ${out}\n  open in a browser (file://) - read-only, no server`;
  } finally {
    db.close();
  }
}
