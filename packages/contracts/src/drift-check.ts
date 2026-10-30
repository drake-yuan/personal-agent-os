/**
 * CI drift check (P2-01): the TS enums in this package are the single
 * generation source. This script verifies that the SQLite CHECK
 * constraint documentation in packages/db/src/ddl-doc.ts and the
 * schema files under schemas/ agree with the enums. Any drift fails CI.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

  // DTO boundary (ADR-004): the cockpit payload's distribution maps must be a
  // faithful, complete projection of the canonical enums. COCKPIT_DISTRIBUTION_ENUMS
  // in @paos/api is the human-authored field->enum mapping; pin it so a refactor
  // that points a field at the wrong enum (or drops a key) fails CI instead of
  // silently shipping a broken board. @paos/api is built before drift:check in CI
  // (Build runs first), and we import its built artifact by file path so the
  // contracts package never takes a (circular) dependency on @paos/api.
  try {
    const apiConstantsUrl = pathToFileURL(
      path.join(repoRoot(), 'packages/api/dist/constants.js'),
    ).href;
    const apiConstants = (await import(apiConstantsUrl)) as {
      COCKPIT_DISTRIBUTION_ENUMS: Record<string, readonly string[]>;
    };
    const expected: Record<string, readonly string[]> = {
      tasksByStatus: TASK_STATUS,
      tasksByRisk: RISK_LEVEL,
      runsByStatus: WORKFLOW_RUN_STATUS,
      dispatchByState: DISPATCH_STATE,
    };
    const actualKeys = Object.keys(apiConstants.COCKPIT_DISTRIBUTION_ENUMS).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      failures.push(
        `api.COCKPIT_DISTRIBUTION_ENUMS keys drift: have [${actualKeys.join(',')}], want [${expectedKeys.join(',')}]`,
      );
    }
    for (const field of expectedKeys) {
      const actual = apiConstants.COCKPIT_DISTRIBUTION_ENUMS[field] ?? [];
      check(`api.${field}`, [...actual], expected[field] as readonly string[]);
    }
  } catch (err) {
    failures.push(`drift check crashed loading @paos/api: ${(err as Error).message}`);
  }
} catch (err) {
  failures.push(`drift check crashed: ${(err as Error).message}`);
}

if (failures.length > 0) {
  console.error('DRIFT CHECK FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('drift check OK: enums, DDL docs, schemas and @paos/api DTO distribution maps agree');
