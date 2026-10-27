import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, cmdInit, cmdStatus, cmdDoctor, cmdPluginInspect, cmdApprovals, cmdEvals } from '../src/index.js';

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

  it('doctor runs five levels for the demo adapter', async () => {
    const out = await cmdDoctor();
    expect(out.split('\n')).toHaveLength(5);
    expect(out).toContain('PASS');
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
