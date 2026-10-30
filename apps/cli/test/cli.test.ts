import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, cmdInit, cmdStatus, cmdDoctor, cmdPluginInspect, cmdApprovals, cmdEvals, buildAdapter, canonicalAdapterId, cmdBackup, cmdRestore, cmdMigrate, createBackup, normalizeContractPaths } from '../src/index.js';

// Node 22.22 bundles SQLite 3.51.2, just below the 3.51.3 WAL-reset
// gate. Use the documented escape hatch for tests (design Section 6.3 rule 6).
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';

let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'paos-cli-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('paos CLI', () => {
  it('parses commands, positionals and flags', () => {
    const p = parseArgs(['plugin', 'inspect', './manifest.json', '--data-dir=/tmp/x']);
    expect(p.command).toBe('plugin inspect');
    expect(p.positional).toEqual(['./manifest.json']);
    expect(p.flags['data-dir']).toBe('/tmp/x');
    const d = parseArgs(['adapter', 'doctor']);
    expect(d.command).toBe('adapter doctor');
    expect(parseArgs([]).command).toBe('help');
  });

  it('init creates a DB, secret file and applies migrations', () => {
    const dataDir = path.join(dir, 'data1');
    const out = cmdInit(dataDir);
    expect(out.applied).toEqual([1]);
    expect(out.dbPath.endsWith('paos.db')).toBe(true);
    const status = cmdStatus(dataDir);
    expect(status).toContain('sqlite');
    expect(status).toContain('inbox=0');
  });

  it('status reports not-initialized before init', () => {
    expect(cmdStatus(path.join(dir, 'nope'))).toContain('paos init');
  });

  it('backup snapshots DB + secret, restore recovers them, migrate checkpoints', () => {
    const dataDir = path.join(dir, 'data-bk');
    cmdInit(dataDir);
    const bk = createBackup(dataDir);
    expect(bk.files).toContain('paos.db');
    expect(bk.files).toContain('manifest.json');
    // Manifest is authoritative: restore rejects a non-backup directory.
    const badDir = mkdtempSync(path.join(dir, 'not-a-backup-'));
    writeFileSync(path.join(badDir, 'random.txt'), 'x');
    expect(() => cmdRestore(badDir, path.join(dir, 'nope2'))).toThrow(/not a paos backup/);
    // Restore into a fresh dir and confirm the DB is intact.
    const restored = path.join(dir, 'restored');
    const msg = cmdRestore(bk.dir, restored);
    expect(msg).toContain('restored into');
    expect(cmdStatus(restored)).toContain('inbox=0');
    // Migrate takes a checkpoint and is idempotent.
    const mig = cmdMigrate(restored);
    expect(mig).toContain('migration checkpoint');
    expect(mig).toContain('schema versions: 1 -> 1');
  });

  it('doctor runs five levels per adapter and covers the real CLI ones', async () => {
    const demo = await cmdDoctor('demo-adapter');
    // one header + five levels
    expect(demo.split('\n')).toHaveLength(6);
    expect(demo.startsWith('demo-adapter')).toBe(true);
    expect(demo).toContain('PASS');

    const all = await cmdDoctor();
    expect(all).toContain('codex-adapter');
    expect(all).toContain('claude-code-adapter');
    expect(all).toContain('gemini-adapter');
    expect(all).toContain('qwen-code-adapter');
    // Gate G3 adapter: registered and diagnosable even while unconfigured.
    expect(all).toContain('workbuddy-adapter');
  }, 30000);

  it('doctor rejects an unknown adapter id instead of exiting 0', async () => {
    await expect(cmdDoctor('nope-adapter')).rejects.toThrow(/unknown adapter/);
  });

  it('buildAdapter selects by id and fails closed on unknown ids', () => {
    expect(buildAdapter(undefined, []).id).toBe('demo-adapter');
    expect(buildAdapter('demo', []).id).toBe('demo-adapter');
    expect(buildAdapter('codex-adapter', []).id).toBe('codex-adapter');
    expect(buildAdapter('claude-code', []).id).toBe('claude-code-adapter');
    expect(buildAdapter('gemini', []).id).toBe('gemini-adapter');
    expect(buildAdapter('gemini-adapter', []).id).toBe('gemini-adapter');
    expect(buildAdapter('qwen', []).id).toBe('qwen-code-adapter');
    expect(buildAdapter('qwen-code', []).id).toBe('qwen-code-adapter');
    expect(buildAdapter('qwen-code-adapter', []).id).toBe('qwen-code-adapter');
    expect(buildAdapter('workbuddy', []).id).toBe('workbuddy-adapter');
    expect(canonicalAdapterId('gemini')).toBe('gemini-adapter');
    expect(canonicalAdapterId('qwen')).toBe('qwen-code-adapter');
    expect(canonicalAdapterId('workbuddy')).toBe('workbuddy-adapter');
    expect(() => buildAdapter('nope', [])).toThrow(/unknown adapter/);
  });

  it('the WorkBuddy adapter is selectable but fails closed while unconfigured', async () => {
    // Reachable from `run`/`doctor` (was "unknown adapter" before), yet it
    // cannot take work without credentials: enforced capabilities stay empty.
    const adapter = buildAdapter('workbuddy', []);
    const health = await adapter.probe();
    expect(health.authenticated).toBe(false);
    expect(health.enforcedCapabilities).toEqual([]);
    expect(health.diagnostics[0]?.code).toBe('E_WORKBUDDY_NOT_CONFIGURED');
  });

  it('aliases resolve identically for run and doctor', async () => {
    // A alias accepted by `run` must also be accepted by `doctor`.
    expect(canonicalAdapterId('demo')).toBe('demo-adapter');
    expect(canonicalAdapterId('claude-code')).toBe('claude-code-adapter');
    expect(canonicalAdapterId('nope')).toBeUndefined();
    const out = await cmdDoctor('demo');
    expect(out.startsWith('demo-adapter')).toBe(true);
  });

  it('parseArgs reads --adapter with a space or equals value', () => {
    expect(parseArgs(['run', 'c.json', '--adapter', 'codex-adapter']).flags['adapter']).toBe('codex-adapter');
    expect(parseArgs(['run', 'c.json', '--adapter=claude-code-adapter']).flags['adapter']).toBe('claude-code-adapter');
  });

  it('plugin inspect validates manifests with zero code execution', () => {
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({
      id: 'codex-adapter', kind: 'agent-adapter', version: '0.1.0',
      source: 'builtin', capabilities: ['fs.read.workspace'], enforced_isolation: 'workspace-fs',
    }));
    const out = cmdPluginInspect(manifestPath);
    expect(out).toContain('inspect OK');
    expect(out).toContain('no code executed');

    const badPath = path.join(dir, 'bad.json');
    writeFileSync(badPath, JSON.stringify({ id: 'x' }));
    expect(cmdPluginInspect(badPath)).toContain('inspect FAILED');
  });

  it('accepts space-separated flag values and boolean flags', () => {
    const p = parseArgs(['approve', 'apr_1', '--contract', 'c.json', '--token', 't', '--deny']);
    expect(p.command).toBe('approve');
    expect(p.positional).toEqual(['apr_1']);
    expect(p.flags['contract']).toBe('c.json');
    expect(p.flags['token']).toBe('t');
    expect(p.flags['deny']).toBe(true);
  });

  it('approvals reports an uninitialised install instead of throwing', () => {
    const missing = path.join(dir, 'nope');
    expect(cmdApprovals(missing)).toContain('not initialized');
  });

  describe('evals', () => {
    it('runs the shipped gate suite and writes a report under the data dir', () => {
      const dataDir = path.join(dir, 'data-evals');
      const out = cmdEvals({
        command: 'evals',
        positional: [],
        flags: { 'data-dir': dataDir },
      });
      expect(out).toContain('scenario-coverage');
      expect(out).toContain('verdict: PASS');
      expect(out).toContain('report:');
      expect(existsSync(path.join(dataDir, 'eval-runs'))).toBe(true);
    });

    it('reports failures instead of throwing when a case can be parsed but not covered', () => {
      const casesPath = path.join(dir, 'partial.jsonl');
      writeFileSync(casesPath, `${JSON.stringify({ id: 'a', scenario: 'success', description: 'd' })}\n`);
      const out = cmdEvals({
        command: 'evals',
        positional: [],
        flags: { 'data-dir': path.join(dir, 'data-evals2'), cases: casesPath },
      });
      expect(out).toContain('verdict: FAIL');
      expect(out).toContain('uncovered scenarios:');
      expect(out).toContain('prompt-injection');
    });

    it('can emit machine-readable JSON', () => {
      const out = cmdEvals({
        command: 'evals',
        positional: [],
        flags: { 'data-dir': path.join(dir, 'data-evals3'), json: true },
      });
      const parsed = JSON.parse(out) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.results.length).toBeGreaterThan(0);
    });
  });
});

describe('normalizeContractPaths (cross-platform boundary)', () => {
  it('normalizes a POSIX workspace and scope_paths to the host native form', () => {
    const raw = {
      contract_version: '1.1', task_id: 't1', workflow_run_id: 'w1', step_id: 's1',
      objective: 'read seed.txt', domain: 'read', workflow: { id: 'wf', version: '1' },
      inputs: { workspace: '/tmp/paos-cli-test' },
      requirements: {
        required_capabilities: ['fs.read.workspace'],
        scope_paths: ['/tmp/paos-cli-test', '/tmp/paos-cli-test/out'],
        data_classification: 'public' as const,
      },
    } as unknown as ContractV11;
    const norm = normalizeContractPaths(raw);
    if (process.platform === 'win32') {
      expect(path.isAbsolute(norm.inputs.workspace)).toBe(true);
      expect(norm.inputs.workspace).toContain('\\');
      expect(norm.inputs.workspace.startsWith('/tmp')).toBe(false);
      for (const sc of norm.requirements.scope_paths) {
        expect(path.isAbsolute(sc)).toBe(true);
        expect(sc).toContain('\\');
      }
    } else {
      expect(norm.inputs.workspace).toBe('/tmp/paos-cli-test');
    }
  });

  it('is idempotent (normalizing twice equals normalizing once)', () => {
    const raw = { inputs: { workspace: '/tmp/x' }, requirements: { scope_paths: ['/tmp/x'] } } as unknown as ContractV11;
    const once = normalizeContractPaths(raw);
    const twice = normalizeContractPaths(once);
    expect(twice.inputs.workspace).toBe(once.inputs.workspace);
    expect(twice.requirements.scope_paths).toEqual(once.requirements.scope_paths);
  });
});
