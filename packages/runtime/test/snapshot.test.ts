import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { takeSnapshot, diffSnapshots, inScope, escapesRoot } from '../src/snapshot.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'paos-snap-root-'));
  outside = mkdtempSync(path.join(tmpdir(), 'paos-snap-out-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'tests'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.ts'), 'v1');
  writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('workspace snapshot escape detection (Section 8.5, P0-07)', () => {
  it('records per-file sha256', () => {
    const snap = takeSnapshot(root);
    expect(snap.entries.get('src/a.ts')?.kind).toBe('file');
    expect(snap.entries.get('src/a.ts')?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects added / modified / deleted inside scope', () => {
    const before = takeSnapshot(root);
    writeFileSync(path.join(root, 'src', 'b.ts'), 'new');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'v2');
    rmSync(path.join(root, 'tests', 'keep.ts'), { force: true });
    const after = takeSnapshot(root);
    const diff = diffSnapshots(before, after, ['src/', 'tests/']);
    expect(diff.added).toContain('src/b.ts');
    expect(diff.modified).toContain('src/a.ts');
    expect(diff.escaped).toEqual([]);
  });

  it('flags writes outside the licensed scope as escaped', () => {
    const before = takeSnapshot(root);
    writeFileSync(path.join(root, 'secret.env'), 'KEY=1');
    const after = takeSnapshot(root);
    const diff = diffSnapshots(before, after, ['src/']);
    expect(diff.escaped).toContain('secret.env');
  });

  it('flags symlinks pointing outside the root', () => {
    try {
      symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'), 'file');
    } catch {
      return; // symlink privileges unavailable on this host
    }
    const before = takeSnapshot(root);
    const after = takeSnapshot(root);
    const diff = diffSnapshots(before, after, ['src/']);
    expect(diff.escaped).toContain('link.txt');
    rmSync(path.join(root, 'link.txt'), { force: true });
  });

  it('inScope handles prefixes and separators', () => {
    expect(inScope('src/a.ts', ['src/'])).toBe(true);
    expect(inScope('src/a.ts', ['src'])).toBe(true);
    expect(inScope('srcx/a.ts', ['src/'])).toBe(false);
    expect(inScope('docs/x.md', ['src/'])).toBe(false);
  });

  it('escapesRoot rejects traversal and absolute paths', () => {
    expect(escapesRoot(root, '../outside')).toBe(true);
    expect(escapesRoot(root, outside)).toBe(true);
    expect(escapesRoot(root, 'src/a.ts')).toBe(false);
  });
});
