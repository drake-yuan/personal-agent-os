import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { normalizeHostPath } from '../src/path.js';

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
