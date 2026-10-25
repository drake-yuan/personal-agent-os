import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, cmdInit, cmdStatus, cmdDoctor, cmdPluginInspect } from '../src/index.js';

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
});
