import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliEntry, spawnCli, denyApproval } from '../src/actions.js';

// A tiny fake CLI that echoes its argv as JSON and exits with a chosen code.
// Lets us exercise the spawn+argv path without touching a real database.
let fakeCli: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'paos-actions-fake-'));
  fakeCli = join(dir, 'fake-cli.mjs');
  writeFileSync(
    fakeCli,
    'const args = process.argv.slice(2);' +
      'const code = Number(process.env.FAKE_CODE ?? "0");' +
      'process.stdout.write(JSON.stringify({ args }));' +
      'process.exit(code);\n',
  );
});

describe('actions: resolveCliEntry', () => {
  it('points at the sibling index.js', () => {
    expect(resolveCliEntry().replace(/\\/g, '/')).toMatch(/src\/index\.js$|dist\/index\.js$/);
  });
});

describe('actions: spawnCli', () => {
  it('forwards argv to the child and captures stdout', async () => {
    const r = await spawnCli(['approve', 'abc', '--deny'], { cliEntry: fakeCli });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).args).toEqual(['approve', 'abc', '--deny']);
  });

  it('propagates a non-zero exit as not-ok', async () => {
    const r = await spawnCli(['x'], { cliEntry: fakeCli, nodeBin: process.execPath });
    // fakeCli exits 0 by default; force a failure via env on a second copy path:
    const dir = mkdtempSync(join(tmpdir(), 'paos-actions-fail-'));
    const failCli = join(dir, 'fail.mjs');
    writeFileSync(failCli, 'process.exit(3);\n');
    const r2 = await spawnCli(['x'], { cliEntry: failCli });
    expect(r2.ok).toBe(false);
    expect(r2.code).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('actions: denyApproval guards', () => {
  it('rejects an invalid approval id without spawning', async () => {
    const r = await denyApproval({ dataDir: 'nope', approvalId: 'bad id' });
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/invalid approval id/);
  });

  it('reports when the data dir is not initialized', async () => {
    const r = await denyApproval({ dataDir: 'C:\\does-not-exist-xyz', approvalId: 'a1' });
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/not initialized/);
  });
});
