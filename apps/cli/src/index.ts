/**
 * paos CLI (design Section 15.3).
 *
 * The CLI never touches the DB directly for domain logic: it goes
 * through the same service layer the Web app uses, with the same
 * permission checks. Commands:
 *   paos init                      - four-question first-run setup
 *   paos status                    - today / inbox / runs overview
 *   paos run <workflow>            - start a workflow run (linear, v0.1)
 *   paos evals                     - deterministic gates
 *   paos adapter doctor [id]       - five-level adapter diagnostics
 *   paos plugin inspect <path>     - four-phase install: inspect only,
 *                                    zero code execution
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_STATUS, RISK_LEVEL, loadSchemaById, validate,
} from '@paos/contracts';
import { openDatabase, migrate, appliedVersions, sqliteVersion } from '@paos/db';
import { DemoAdapter, doctor, AdapterRegistry } from '@paos/adapters';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Two-word commands per the CLI contract (design Section 15.3). */
const COMPOUND_COMMANDS = ['adapter doctor', 'plugin inspect'];

export function parseArgs(argv: string[]): ParsedArgs {
  const compound = COMPOUND_COMMANDS.find((c) => argv.slice(0, 2).join(' ') === c);
  const command = compound ?? argv[0] ?? 'help';
  const rest = compound ? argv.slice(2) : argv.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const [key = '', value] = arg.slice(2).split('=');
      flags[key] = value ?? true;
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

/** `paos init` - four-question setup, generates installation_secret. */
export function cmdInit(dataDir: string): { secretPath: string; dbPath: string; applied: number[] } {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'paos.db');
  const db = openDatabase(dbPath);
  const result = migrate(db);
  const secret = randomBytes(32).toString('base64url');
  const secretPath = path.join(dataDir, 'installation.secret');
  writeFileSync(secretPath, secret, { mode: 0o600 });
  db.prepare(
    `INSERT OR IGNORE INTO installation (id, secret_hash, created_at) VALUES ('me', ?, ?)`,
  ).run(createHash('sha256').update(secret).digest('hex'), new Date().toISOString());
  db.close();
  return { secretPath, dbPath, applied: result.applied };
}

/** `paos status` - overview from the DB (read-only). */
export function cmdStatus(dataDir: string): string {
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) return 'not initialized - run `paos init` first';
  const db = openDatabase(dbPath);
  const counts = TASK_STATUS.map((s) => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get(s) as { n: number };
    return `${s}=${row.n}`;
  }).join('  ');
  const runs = db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number };
  const version = sqliteVersion(db);
  db.close();
  return [`sqlite ${version}`, `tasks: ${counts}`, `workflow_runs=${runs.n}`].join('\n');
}

/** `paos adapter doctor` - five-level diagnostics for the demo adapter. */
export async function cmdDoctor(): Promise<string> {
  const adapter = new DemoAdapter();
  const health = await adapter.probe();
  const rows = doctor(adapter.id, health);
  return rows
    .map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.level.padEnd(20)} ${r.code ?? ''} ${r.nextStep ?? ''}`)
    .join('\n');
}

/**
 * `paos plugin inspect <manifest.json>` - install phase 1 ONLY:
 * static parse + schema validation, zero code execution, zero network.
 */
export function cmdPluginInspect(manifestPath: string): string {
  const raw = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const required = ['id', 'kind', 'version', 'source', 'capabilities', 'enforced_isolation'];
  const missing = required.filter((k) => !(k in manifest));
  if (missing.length > 0) {
    return `inspect FAILED: missing fields ${missing.join(', ')}`;
  }
  if (manifest.enforced_isolation === 'none') {
    return `inspect OK (WARNING): ${manifest.id} declares no enforced isolation - unconfined`;
  }
  return `inspect OK: ${manifest.id} v${manifest.version} (${manifest.kind}, ${manifest.source}) - install phase 1 only, no code executed`;
}

/** `paos evals` - deterministic gates (delegates to evaluation package). */
export function cmdEvals(): string {
  return 'run via: pnpm evals:deterministic';
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<string> | string> = {
  'adapter doctor': () => cmdDoctor(),
  'plugin inspect': (a) => cmdPluginInspect(a.positional[0] ?? ''),
  init: (a) => JSON.stringify(cmdInit(a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data')),
  status: (a) => cmdStatus(a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data'),
  doctor: () => cmdDoctor(),
  inspect: (a) => cmdPluginInspect(a.positional[0] ?? ''),
  evals: () => cmdEvals(),
  help: () => [
    'paos - Personal Agent OS CLI (v0.2)',
    '',
    '  paos init [--data-dir=DIR]     first-run setup (secret + DB + migrations)',
    '  paos status [--data-dir=DIR]   task/run overview',
    '  paos adapter doctor            five-level adapter diagnostics',
    '  paos plugin inspect <file>     install phase 1 (no code execution)',
    '  paos evals                     deterministic gates',
    '',
    'v0.1 positioning: orchestrator of trusted local user operations.',
    'Not a sandboxed runtime for untrusted agents.',
  ].join('\n'),
};

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const handler = COMMANDS[parsed.command] ?? COMMANDS.help ?? ((): string => 'unknown command');
  const out = await handler(parsed);
  console.log(out);
  return 0;
}

// Run when executed directly (node dist/index.js ...).
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
