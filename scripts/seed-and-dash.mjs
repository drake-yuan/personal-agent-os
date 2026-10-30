// Demo seeder for the static cockpit. Not part of the test suite; produces a
// realistic SQLite DB so `paos dashboard` can be exercised end-to-end. Run from
// the repo root, then call:  node apps/cli/dist/index.js dashboard --data-dir <dir>
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDatabase,
  migrate,
  insertTask,
  insertWorkflowRun,
  insertApproval,
  insertDispatchIntent,
} from '../packages/db/dist/index.js';

const dir = process.env.PAOS_DEMO_DIR || mkdtempSync(join(tmpdir(), 'paos-demo-'));
const dbPath = join(dir, 'paos.db');
const db = openDatabase(dbPath);
migrate(db);

const now = new Date().toISOString();
let n = 0;
const id = (p) => `${p}-${(++n).toString().padStart(3, '0')}`;
const seedTask = (status, risk, title, domain) =>
  insertTask(db, {
    id: id('T'),
    domain,
    title,
    nextAction: 'next',
    doneCondition: 'done',
    status,
    risk,
    evidenceRefs: status === 'done' ? ['e1', 'e2'] : [],
    createdAt: now,
    updatedAt: now,
  });
const seedRun = (status, taskId) => {
  const runId = id('WR');
  insertWorkflowRun(db, {
    id: runId,
    workflowId: 'wf-demo',
    workflowVersion: '1',
    domain: 'eng',
    taskId,
    status,
    codeVersion: 'demo',
    inputRef: 'in-1',
    createdAt: now,
    updatedAt: now,
  });
  return runId;
};
const seedDispatch = (provider, state, runId) =>
  insertDispatchIntent(db, {
    id: id('D'),
    workflowRunId: runId,
    stepId: 'S-1',
    adapterId: `${provider}-adapter`,
    provider,
    idempotencyKey: `${provider}-k`,
    contractHash: 'c1',
    state,
    supportsServerIdempotency: false,
    createdAt: now,
    updatedAt: now,
  });

seedTask('inbox', 'R1', 'Triage inbound leads scraper', 'startup');
seedTask('planned', 'R2', 'Draft Q3 tax-agent pricing page', 'startup');
seedTask('running', 'R2', 'Refactor verification engine', 'eng');
seedTask('waiting_approval', 'R4', 'Approve external wire transfer', 'finance');
seedTask('review_required', 'R3', 'Verify Cettire share sale receipt', 'stock');
seedTask('blocked', 'R2', 'Unblock OPC registration SOP', 'startup');
seedTask('failed', 'R2', 'Nightly backup to cold storage', 'ops');
seedTask('done', 'R2', 'Ship static cockpit v0.2', 'eng');
seedTask('deferred', 'R1', 'Revisit atom-lab physics sim', 'learn');
seedTask('cancelled', 'R0', 'Abandon legacy scheduler', 'ops');

const runA = seedRun('running', 'T-003');
seedRun('succeeded', 'T-008');
seedRun('failed', 'T-007');

seedDispatch('codex', 'reconciled', runA);
seedDispatch('claude-code', 'pending', runA);
seedDispatch('gemini', 'rejected', runA);

insertApproval(db, {
  id: 'A-001',
  workflowRunId: runA,
  stepId: 'S-1',
  risk: 'R4',
  action: 'external_send: wire_transfer(USD 5000)',
  actionHash: 'h1',
  resourceScopeHash: 'r1',
  decision: 'pending',
  createdAt: now,
  updatedAt: now,
});

db.close();
writeFileSync(join(dir, '.demo-dir'), dir, 'utf8');
console.log('seeded DB at', dir);
