import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { normalizeHostPath, mapPathAlias, type PathAlias } from '../src/path.js';

describe('normalizeHostPath', () => {
  const isWin = process.platform === 'win32';

  it('maps the POSIX /tmp prefix to the host temp dir on Windows', () => {
    if (!isWin) return; // POSIX hosts keep /tmp as-is
    const out = normalizeHostPath('/tmp/paos-g2b-ws');
    expect(out.startsWith(os.tmpdir())).toBe(true);
    expect(out).toContain('\\'); // native separators, never a forward slash
    expect(out.endsWith('paos-g2b-ws')).toBe(true);
  });

  it('maps a /tmp/sub/path prefix to the host temp dir on Windows', () => {
    if (!isWin) return;
    const out = normalizeHostPath('/tmp/a/b/c');
    expect(out).toBe(path.join(os.tmpdir(), 'a', 'b', 'c'));
  });

  it('converts forward slashes to native separators on Windows', () => {
    if (!isWin) return;
    const out = normalizeHostPath('C:/Users/DRAKE/AppData/Local/Temp/foo');
    expect(out).toBe('C:\\Users\\DRAKE\\AppData\\Local\\Temp\\foo');
  });

  it('keeps a POSIX absolute path absolute on non-Windows hosts', () => {
    if (isWin) return;
    expect(normalizeHostPath('/tmp/paos-g2b-ws')).toBe('/tmp/paos-g2b-ws');
  });

  it('resolves relative paths to an absolute path', () => {
    const out = normalizeHostPath('./some-workspace');
    expect(path.isAbsolute(out)).toBe(true);
  });

  it('is idempotent (normalizing twice equals normalizing once)', () => {
    const samples = [
      '/tmp/paos-g2b-ws',
      'C:/Users/DRAKE/AppData/Local/Temp/foo',
      './some-workspace',
      process.cwd(),
    ];
    for (const s of samples) {
      expect(normalizeHostPath(normalizeHostPath(s))).toBe(normalizeHostPath(s));
    }
  });

  it('returns empty / falsy input unchanged', () => {
    expect(normalizeHostPath('')).toBe('');
  });
});

describe('mapPathAlias', () => {
  // Platform-neutral aliases: the function is a pure prefix swap and does not
  // care about separators, so we avoid host-specific backslashes here.
  const aliases: PathAlias[] = [
    { from: '/Users/drake', to: '/vol/hostA' },
    { from: '/Users/drake/projects', to: '/vol/hostA/projects' },
  ];

  it('rewrites a foreign prefix to the native one at a segment boundary', () => {
    expect(mapPathAlias('/Users/drake/projects/ws', aliases)).toBe('/vol/hostA/projects/ws');
  });

  it('prefers the longest matching prefix (more specific wins)', () => {
    // "/Users/drake/projects" wins over "/Users/drake".
    expect(mapPathAlias('/Users/drake/projects/ws', aliases)).toBe('/vol/hostA/projects/ws');
    // A path under the shorter prefix only still maps via the shorter alias.
    expect(mapPathAlias('/Users/drake/other', aliases)).toBe('/vol/hostA/other');
  });

  it('does not swallow a same-prefix-but-different-name path', () => {
    // "/Users/drake-x" must NOT match "/Users/drake" (no segment boundary).
    expect(mapPathAlias('/Users/drake-x/ws', aliases)).toBe('/Users/drake-x/ws');
  });

  it('maps a whole-path match directly', () => {
    expect(mapPathAlias('/Users/drake', aliases)).toBe('/vol/hostA');
  });

  it('returns input unchanged when no alias applies or aliases is empty', () => {
    expect(mapPathAlias('/tmp/foo', aliases)).toBe('/tmp/foo');
    expect(mapPathAlias('/tmp/foo', [])).toBe('/tmp/foo');
    expect(mapPathAlias('/tmp/foo', undefined)).toBe('/tmp/foo');
    expect(mapPathAlias('')).toBe('');
  });

  it('is idempotent (rewritten path no longer matches any from)', () => {
    const out = mapPathAlias('/Users/drake/projects/ws', aliases);
    expect(mapPathAlias(out, aliases)).toBe(out);
  });
});

describe('normalizeHostPath with aliases', () => {
  const isWin = process.platform === 'win32';

  it('applies the alias then normalizes to the host native form on Windows', () => {
    const aliases: PathAlias[] = [{ from: '/Users/drake/ws', to: 'C:\\Users\\DRAKE\\ws' }];
    const out = normalizeHostPath('/Users/drake/ws/sub', aliases);
    if (isWin) {
      expect(out.startsWith('C:\\Users\\DRAKE\\ws')).toBe(true);
      expect(out.endsWith('sub')).toBe(true);
      expect(out).toContain('\\');
      expect(out).not.toContain('/');
    } else {
      // On POSIX a Windows-style `to` is still resolved to an absolute path.
      expect(path.isAbsolute(out)).toBe(true);
    }
  });

  it('alias precedence beats the built-in /tmp mapping', () => {
    const a: PathAlias[] = [{ from: '/tmp', to: 'D:\\custom-tmp' }];
    const out = normalizeHostPath('/tmp/ws', a);
    if (isWin) {
      expect(out.startsWith('D:\\custom-tmp')).toBe(true);
      expect(out).not.toContain('AppData'); // not the OS temp dir
    } else {
      expect(out).toBe('/tmp/ws');
    }
  });

  it('stays idempotent with aliases applied', () => {
    const aliases: PathAlias[] = [{ from: '/Users/drake/ws', to: 'C:\\Users\\DRAKE\\ws' }];
    const samples = ['/Users/drake/ws/sub', '/tmp/x', process.cwd()];
    for (const s of samples) {
      expect(normalizeHostPath(normalizeHostPath(s, aliases), aliases)).toBe(normalizeHostPath(s, aliases));
    }
  });
});
