/**
 * CI drift check (P2-01): the TS enums in this package are the single
 * generation source. This script verifies that the SQLite CHECK
 * constraint documentation in packages/db/src/ddl-doc.ts and the
 * schema files under schemas/ agree with the enums. Any drift fails CI.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_STATUS, WORKFLOW_RUN_STATUS, STEP_STATUS, DISPATCH_STATE,
  APPROVAL_DECISION, RISK_LEVEL, STEP_KIND,
} from './enums.js';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (readdirSync(dir).includes('pnpm-workspace.yaml')) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const failures: string[] = [];

function check(name: string, inSchema: string[], inEnum: readonly string[]): void {
  const missing = inEnum.filter((v) => !inSchema.includes(v));
  const extra = inSchema.filter((v) => !(inEnum as readonly string[]).includes(v));
  if (missing.length > 0) failures.push(`${name}: enum values missing from schema: ${missing.join(',')}`);
  if (extra.length > 0) failures.push(`${name}: schema has values not in enum: ${extra.join(',')}`);
}

function extractEnum(file: string, key: string): string[] {
  const doc = JSON.parse(readFileSync(path.join(repoRoot(), file), 'utf8')) as Record<string, never>;
  const node = doc[key];
  if (node === undefined) throw new Error(`key ${key} not found in ${file}`);
  return node as string[];
}

try {
  check('tasks.status', extractEnum('packages/db/src/ddl-doc.json', 'tasks.status'), TASK_STATUS);
  check('workflow_runs.status', extractEnum('packages/db/src/ddl-doc.json', 'workflow_runs.status'), WORKFLOW_RUN_STATUS);
  check('run_steps.status', extractEnum('packages/db/src/ddl-doc.json', 'run_steps.status'), STEP_STATUS);
  check('run_steps.kind', extractEnum('packages/db/src/ddl-doc.json', 'run_steps.kind'), STEP_KIND);
  check('dispatch_intents.state', extractEnum('packages/db/src/ddl-doc.json', 'dispatch_intents.state'), DISPATCH_STATE);
  check('approvals.decision', extractEnum('packages/db/src/ddl-doc.json', 'approvals.decision'), APPROVAL_DECISION);
  check('tasks.risk', extractEnum('packages/db/src/ddl-doc.json', 'tasks.risk'), RISK_LEVEL);

  const contract = JSON.parse(readFileSync(path.join(repoRoot(), 'schemas/agent-task-contract-1.1.0.json'), 'utf8')) as {
    properties: { policy: { properties: { risk_level: { enum: string[] } } } };
  };
  check('contract.policy.risk_level', contract.properties.policy.properties.risk_level.enum, RISK_LEVEL);
} catch (err) {
  failures.push(`drift check crashed: ${(err as Error).message}`);
}

if (failures.length > 0) {
  console.error('DRIFT CHECK FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('drift check OK: enums, DDL docs and schemas agree');
