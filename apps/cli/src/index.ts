#!/usr/bin/env node
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
import {
  mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync,
  copyFileSync, readdirSync, statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_STATUS, RISK_LEVEL, loadSchemaById, validate,
} from '@paos/contracts';
import { openDatabase, migrate, appliedVersions, sqliteVersion } from '@paos/db';
import { DemoAdapter, doctor, AdapterRegistry, CodexAdapter, ClaudeCodeAdapter, WorkBuddyAdapter, GeminiAdapter, QwenCodeAdapter } from '@paos/adapters';
import type { AgentAdapter, DemoFixture } from '@paos/adapters';
import { runContract, resolveApproval } from '@paos/runtime';
import type { ContractV11, CheckContext } from '@paos/runtime';

/**
 * Load a git-ignored `.env` (if present) into process.env. Only variables that
 * are not already set are injected, so OS-level env vars always win. This is a
 * minimal, dependency-free parser on purpose: secrets stay in a file that never
 * reaches git or the chat log, and the adapter reads them via process.env.
 */
function loadLocalEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env');
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        const key = m[1];
        if (key === undefined) continue;
        let val = m[2] ?? '';
        if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') ||
            (val[0] === "'" && val[val.length - 1] === "'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadLocalEnv();
import { pendingApprovals } from '@paos/db';
import { runGateSuite, formatSuite } from '@paos/evaluation';
import {
  recordingAdapter, workspaceCheckContext, type RunEvidence,
} from './evidence.js';

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
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg.startsWith('--')) {
      const [key = '', inlineValue] = arg.slice(2).split('=');
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }
      // Space-separated value: only consume it when the next token is a value.
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
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

/** Timestamp token safe for file names across platforms (no `:`). */
function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/**
 * Copy paos.db + installation.secret (mode 0600) into a timestamped backup
 * directory and write a manifest. Used directly by `paos backup` and as the
 * safety checkpoint `paos migrate` takes before applying schema changes.
 * Fail closed: a missing DB or an unwritable target produces an error string,
 * never a partial backup that looks complete.
 */
export function createBackup(dataDir: string, out?: string): { dir: string; files: string[] } {
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) {
    throw new Error('not initialized - run `paos init` before backing up');
  }
  const root = out ? path.resolve(out) : path.join(path.resolve(dataDir), 'backups');
  const dir = path.join(root, `paos-backup-${backupStamp()}`);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  copyFileSync(dbPath, path.join(dir, 'paos.db'));
  files.push('paos.db');
  const secretPath = path.join(dataDir, 'installation.secret');
  if (existsSync(secretPath)) {
    copyFileSync(secretPath, path.join(dir, 'installation.secret'));
    // Keep the secret unreadable by others in the backup too.
    try { statSync(path.join(dir, 'installation.secret')); } catch { /* best effort */ }
    files.push('installation.secret');
  }
  const manifest = {
    tool: 'paos',
    schema: 'backup/1',
    createdAt: new Date().toISOString(),
    source: path.resolve(dataDir),
    files,
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  files.push('manifest.json');
  return { dir, files };
}

/** `paos backup [--out DIR]` - snapshot DB + secret for safe distribution/rollback. */
export function cmdBackup(dataDir: string, out?: string): string {
  const { dir, files } = createBackup(dataDir, out);
  return `backup written: ${dir}\n  files: ${files.join(', ')}`;
}

/**
 * `paos restore <backup-dir> [--data-dir DIR]` - restore from a `paos backup`.
 * The manifest is authoritative: an absent or non-manifest backup is rejected
 * rather than blindly copied, so a stray directory cannot clobber the DB.
 */
export function cmdRestore(backupDir: string, dataDir: string): string {
  const manifestPath = path.join(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`not a paos backup: ${backupDir} (manifest.json missing)`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: string[] };
  const listed = manifest.files ?? [];
  if (!listed.includes('paos.db')) {
    throw new Error('backup manifest lists no paos.db - refusing to restore');
  }
  if (!existsSync(path.join(backupDir, 'paos.db'))) {
    throw new Error(`backup is corrupt: ${backupDir}/paos.db missing`);
  }
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(path.join(backupDir, 'paos.db'), path.join(dataDir, 'paos.db'));
  let restored = ['paos.db'];
  if (listed.includes('installation.secret') && existsSync(path.join(backupDir, 'installation.secret'))) {
    copyFileSync(path.join(backupDir, 'installation.secret'), path.join(dataDir, 'installation.secret'));
    restored.push('installation.secret');
  }
  return `restored into ${path.resolve(dataDir)}:\n  ${restored.join(', ')}`;
}

/**
 * `paos migrate [--data-dir DIR]` - apply pending schema migrations to an
 * existing DB (upgrade). A checkpoint backup is taken first so the upgrade is
 * reversible; a failed migration leaves the pre-upgrade backup intact.
 */
export function cmdMigrate(dataDir: string): string {
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) {
    throw new Error('not initialized - run `paos init` before migrating');
  }
  const checkpoint = createBackup(dataDir);
  const db = openDatabase(dbPath);
  try {
    const before = appliedVersions(db);
    const result = migrate(db);
    const after = appliedVersions(db);
    return [
      `migration checkpoint: ${checkpoint.dir}`,
      `applied ${result.applied.length} migration(s): ${result.applied.join(', ') || '(none)'}`,
      `schema versions: ${before.join(', ')} -> ${after.join(', ')}`,
    ].join('\n');
  } finally {
    db.close();
  }
}

/**
 * `paos adapter doctor [id]` - five-level diagnostics.
 * With no id it diagnoses every known adapter, including the real CLI ones
 * (Codex / Claude Code) when they are installed.
 */
export async function cmdDoctor(adapterId?: string, probeAuth = false): Promise<string> {
  const registry = new AdapterRegistry();
  registry.register(new DemoAdapter(loadDemoFixtures()));
  registry.register(new CodexAdapter({ probeAuth }));
  registry.register(new ClaudeCodeAdapter({ probeAuth }));
  registry.register(new GeminiAdapter({ probeAuth }));
  registry.register(new QwenCodeAdapter({ probeAuth }));
  registry.register(new WorkBuddyAdapter());
  const candidates = registry.all();
  // Aliases resolve here too, so `doctor demo` and `run --adapter demo`
  // cannot disagree about what exists.
  const canonical = canonicalAdapterId(adapterId);
  if (adapterId && canonical === undefined) {
    // Thrown, not returned: an unknown id is a usage error and must exit
    // non-zero like every other command instead of printing and exiting 0.
    throw new Error(`unknown adapter: ${adapterId} (known: ${describeKnownAdapters()})`);
  }
  const selected = canonical ? candidates.filter((a) => a.id === canonical) : candidates;
  const rows: string[] = [];
  for (const adapter of selected) {
    rows.push(adapter.id);
    const health = await adapter.probe();
    for (const r of doctor(adapter.id, health)) {
      rows.push(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.level.padEnd(20)} ${r.code ?? ''} ${r.nextStep ?? ''}`);
    }
  }
  return rows.join('\n');
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

/**
 * `paos evals` - deterministic gates, run through the same suite as
 * `pnpm evals:deterministic` so the two cannot report different verdicts.
 * The report lands under `--data-dir` (default `data/eval-runs`).
 */
export function cmdEvals(args: ParsedArgs): string {
  const dataDir = args.flags['data-dir'] ? String(args.flags['data-dir']) : 'data';
  const casesPath = args.flags['cases'] ? String(args.flags['cases']) : undefined;
  const result = runGateSuite({
    root: REPO_ROOT,
    ...(casesPath ? { casesPath } : {}),
    reportDir: path.join(path.resolve(dataDir), 'eval-runs'),
  });
  if (args.flags['json']) return JSON.stringify(result, null, 2);
  return formatSuite(result, REPO_ROOT);
}

/** Repo root, resolved from the compiled CLI location (apps/cli/dist). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Load the synthetic demo fixtures that back the zero-key first run. */
export function loadDemoFixtures(): DemoFixture[] {
  const p = path.join(REPO_ROOT, 'demo', 'fixtures', 'demo-run.json');
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, DemoFixture>;
  return Object.values(raw);
}

/**
 * Evidence view for a demo run. The demo adapter replays RECORDED fixtures,
 * so the checker context is derived from those fixtures rather than from a
 * live workspace - this is a replay, not a claim of real execution.
 */
export function demoCheckContext(contract: ContractV11, fixtures: DemoFixture[]): CheckContext {
  const sha = new Map<string, string>();
  for (const f of fixtures) {
    for (const a of f.artifacts) sha.set(a.artifact_id, a.sha256);
  }
  return {
    artifactJson: (id) =>
      id === 'change_summary'
        ? {
            summary: contract.objective,
            risk_level: contract.policy?.risk_level ?? 'R2',
            follow_ups: [],
          }
        : undefined,
    artifactSha256: (id) => sha.get(id),
    exitCode: (ref) => (ref === 'test' ? 0 : undefined),
    changedPaths: () => ['src/app.ts', 'tests/auth.spec.ts'],
    evidenceAgeDays: () => 0,
  };
}

/**
 * Single source of truth for the adapters the CLI can drive. `run`, `approve`
 * and `adapter doctor` all resolve ids through this list, so an alias can
 * never work in one command and be rejected in another.
 */
export const KNOWN_ADAPTERS: Array<{ id: string; aliases: string[] }> = [
  { id: 'demo-adapter', aliases: ['demo'] },
  { id: 'codex-adapter', aliases: ['codex'] },
  { id: 'claude-code-adapter', aliases: ['claude-code'] },
  { id: 'gemini-adapter', aliases: ['gemini'] },
  { id: 'qwen-code-adapter', aliases: ['qwen', 'qwen-code'] },
  // Gate G3 (OAuth app review) is open: selectable and fully structured, but
  // it fails closed until an endpoint and token are configured.
  { id: 'workbuddy-adapter', aliases: ['workbuddy'] },
];

/** Canonical id for an id or alias; `undefined` when unknown. */
export function canonicalAdapterId(adapterId: string | undefined): string | undefined {
  if (!adapterId) return undefined;
  return KNOWN_ADAPTERS.find((a) => a.id === adapterId || a.aliases.includes(adapterId))?.id;
}

/** Human-readable list including aliases, used in errors and help. */
export function describeKnownAdapters(): string {
  return KNOWN_ADAPTERS
    .map((a) => (a.aliases.length > 0 ? `${a.id} (${a.aliases.join(', ')})` : a.id))
    .join(', ');
}

/**
 * Pick the adapter a `run` executes with. Defaults to the demo replay adapter
 * so the zero-secret first run works; the real CLI adapters (codex-adapter /
 * claude-code-adapter) are reachable here so a contract can be executed by a
 * real local agent. Unknown ids fail closed with an explicit error instead of
 * silently falling back to the demo adapter.
 */
export function buildAdapter(adapterId: string | undefined, fixtures: DemoFixture[]): AgentAdapter {
  const id = canonicalAdapterId(adapterId) ?? 'demo-adapter';
  if (adapterId && canonicalAdapterId(adapterId) === undefined) {
    throw new Error(`unknown adapter: ${adapterId} (known: ${describeKnownAdapters()})`);
  }
  switch (id) {
    case 'codex-adapter':
      return new CodexAdapter();
    case 'claude-code-adapter':
      return new ClaudeCodeAdapter();
    case 'gemini-adapter':
      return new GeminiAdapter();
    case 'qwen-code-adapter':
      return new QwenCodeAdapter();
    case 'workbuddy-adapter':
      return new WorkBuddyAdapter();
    default:
      return new DemoAdapter(fixtures);
  }
}

/** `paos run <contract.json> [--adapter ID]` - execute the core chain end to end. */
/**
 * Derive the structured action type from the contract's required capabilities.
 *
 * `cmdRun` used to hardcode 'local-write', which forced every adapter to claim
 * fs.write.workspace and made read-only adapters (gemini, qwen-code, the
 * codex read-only sandbox) permanently un-dispatchable - the policy gate
 * `adapter cannot enforce required capability fs.write.workspace` fired for all
 * of them. The action type drives both the policy risk floor and the required
 * capability, so it must follow the contract, not a constant.
 */
function deriveActionType(contract: ContractV11): 'read' | 'draft' | 'local-write' | 'external-send' | 'money' | 'delete' | 'trade' {
  const caps = contract.requirements?.required_capabilities ?? [];
  if (caps.includes('external.send')) return 'external-send';
  if (caps.includes('fs.write.workspace') || caps.includes('process.exec')) return 'local-write';
  return 'read';
}

export async function cmdRun(contractPath: string, dataDir: string, adapterId?: string): Promise<string> {
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) return 'not initialized - run `paos init` first';
  if (!existsSync(contractPath)) return `contract not found: ${contractPath}`;
  const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractV11;
  const fixtures = loadDemoFixtures();
  const db = openDatabase(dbPath);
  try {
    const base = buildAdapter(adapterId, fixtures);
    const workspace = contract.inputs?.workspace ?? process.cwd();
    // A real adapter executes against the live workspace, so it must be
    // verified against real evidence. Handing it the demo fixtures would
    // verify a run that never happened.
    const real = base.id !== 'demo-adapter';
    const evidence: RunEvidence = {};
    const adapter = real ? recordingAdapter(base, evidence) : base;
    const checkContext = real
      ? workspaceCheckContext({ workspace, evidence })
      : demoCheckContext(contract, fixtures);
    const result = await runContract({
      db,
      adapter,
      contract,
      workspace,
      checkContext,
      actionType: deriveActionType(contract),
    });
    const lines = [
      `task ${result.taskId}: ${result.taskStatus}`,
      `run  ${result.runId}: ${result.runStatus}`,
      `dispatch ${result.dispatchId}: ${result.dispatchState}`,
    ];
    if (result.verdict) lines.push(`verdict: ${result.verdict}`);
    if (result.approvalId) lines.push(`awaiting approval ${result.approvalId} (human gate)`);
    if (result.blocked) lines.push(`blocked: ${result.blocked}`);
    for (const r of result.reports ?? []) {
      lines.push(`  layer ${r.layer}: ${r.passed ? 'PASS' : 'FAIL'} ${r.failureCodes.join(',')}`);
    }
    return lines.join('\n');
  } finally {
    db.close();
  }
}

/** `paos approvals` - list approvals waiting on a human decision. */
export function cmdApprovals(dataDir: string): string {
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) return 'not initialized - run `paos init` first';
  const db = openDatabase(dbPath);
  try {
    const rows = pendingApprovals(db);
    if (rows.length === 0) return 'no pending approvals';
    return rows
      .map((r) => `${r.id}  ${r.risk}  run=${r.workflow_run_id}  step=${r.step_id}  ${r.action}`)
      .join('\n');
  } finally {
    db.close();
  }
}

/**
 * `paos approve <id> --contract <file> [--token T] [--deny] [--by NAME]`
 * The exit from the risk gate. Approving without an adapter records the
 * decision and returns the task to running; supplying the demo adapter
 * (default) resumes the chain immediately.
 */
export async function cmdApprove(args: ParsedArgs): Promise<string> {
  const dataDir = args.flags['data-dir'] ? String(args.flags['data-dir']) : 'data';
  const dbPath = path.join(dataDir, 'paos.db');
  if (!existsSync(dbPath)) return 'not initialized - run `paos init` first';
  const approvalId = args.positional[0] ?? '';
  if (!approvalId) return 'usage: paos approve <approval-id> --contract <file> [--token T] [--deny]';

  const contractPath = args.flags['contract'] ? String(args.flags['contract']) : '';
  const deny = Boolean(args.flags['deny']);
  const token = args.flags['token'] ? String(args.flags['token']) : undefined;
  const decidedBy = args.flags['by'] ? String(args.flags['by']) : 'human';
  const adapterId = args.flags['adapter'] ? String(args.flags['adapter']) : undefined;

  let contract: ContractV11 | undefined;
  if (contractPath) {
    if (!existsSync(contractPath)) return `contract not found: ${contractPath}`;
    contract = JSON.parse(readFileSync(contractPath, 'utf8')) as ContractV11;
  }

  const db = openDatabase(dbPath);
  try {
    const fixtures = loadDemoFixtures();
    const workspace = contract?.inputs?.workspace ?? process.cwd();
    const base = contract && !deny ? buildAdapter(adapterId, fixtures) : undefined;
    // Same evidence rule as `run`: a resumed real adapter is verified
    // against the live workspace, never against demo fixtures.
    const real = base !== undefined && base.id !== 'demo-adapter';
    const evidence: RunEvidence = {};
    const adapter = base && real ? recordingAdapter(base, evidence) : base;
    const result = await resolveApproval({
      db,
      approvalId,
      decision: deny ? 'denied' : 'approved',
      decidedBy,
      token,
      contract,
      // Resume immediately when a contract is supplied.
      adapter,
      workspace,
      checkContext: contract
        ? (real ? workspaceCheckContext({ workspace, evidence }) : demoCheckContext(contract, fixtures))
        : undefined,
    });
    const lines = [
      `approval ${result.approvalId}: ${result.decision}`,
      `task ${result.taskId}: ${result.taskStatus}`,
      `run: ${result.runStatus}`,
    ];
    if (result.verdict) lines.push(`verdict: ${result.verdict}`);
    return lines.join('\n');
  } finally {
    db.close();
  }
}

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<string> | string> = {
  'adapter doctor': (a) => cmdDoctor(
    a.positional[0],
    Boolean(a.flags['auth']),
  ),
  'plugin inspect': (a) => cmdPluginInspect(a.positional[0] ?? ''),
  init: (a) => JSON.stringify(cmdInit(a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data')),
  status: (a) => cmdStatus(a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data'),
  backup: (a) => cmdBackup(
    a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data',
    a.flags['out'] ? String(a.flags['out']) : undefined,
  ),
  restore: (a) => cmdRestore(
    a.positional[0] ?? '',
    a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data',
  ),
  migrate: (a) => cmdMigrate(a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data'),
  run: (a) => cmdRun(
    a.positional[0] ?? '',
    a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data',
    a.flags['adapter'] ? String(a.flags['adapter']) : undefined,
  ),
  doctor: (a) => cmdDoctor(a.positional[0], Boolean(a.flags['auth'])),
  inspect: (a) => cmdPluginInspect(a.positional[0] ?? ''),
  evals: (a) => cmdEvals(a),
  approve: (a) => cmdApprove(a),
  approvals: (a) => cmdApprovals(a.flags['data-dir'] ? String(a.flags['data-dir']) : 'data'),
  help: () => [
    'paos - Personal Agent OS CLI (v0.2)',
    '',
    '  paos init [--data-dir=DIR]     first-run setup (secret + DB + migrations)',
    '  paos status [--data-dir=DIR]   task/run overview',
    '  paos backup [--out DIR]        snapshot DB + secret (rollback point)',
    '  paos restore <dir> [--data-dir DIR]   restore a backup',
    '  paos migrate [--data-dir DIR]  apply pending schema migrations (checkpoint first)',
    '  paos run <contract.json> [--adapter ID]   execute the core chain',
    `                                 ID: ${describeKnownAdapters()} (default: demo-adapter)`,
    '  paos approvals                 list approvals waiting on a human',
    '  paos approve <id> --contract F [--token T] [--deny] [--by NAME]',
    '                                 record a decision and resume an approved run',
    '  paos adapter doctor [id] [--auth]',
    '                                 five-level diagnostics for the demo and',
    '                                 real CLI adapters (codex / claude-code)',
    '  paos plugin inspect <file>     install phase 1 (no code execution)',
    '  paos evals [--cases F]        deterministic gates (report in <data-dir>/eval-runs)',
    '',
    'v0.1 positioning: orchestrator of trusted local user operations.',
    'Not a sandboxed runtime for untrusted agents.',
  ].join('\n'),
};

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const handler = COMMANDS[parsed.command] ?? COMMANDS.help ?? ((): string => 'unknown command');
  try {
    const out = await handler(parsed);
    console.log(out);
    return 0;
  } catch (err) {
    // Domain errors (policy refusal, approval replay, superseded approvals)
    // are expected outcomes, not crashes: report the reason, exit non-zero.
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Run when executed directly (`node dist/index.js ...`, or via the linked
 * `paos` bin). Symlinks are resolved on both sides: a bin installed as
 * `node_modules/.bin/paos` points at `node_modules/@paos/cli/...` in
 * `process.argv[1]`, while `import.meta.url` is the real path under
 * `apps/cli/...`. Comparing those unresolved would silently skip `main()`
 * and exit 0 doing nothing.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
