import path from 'node:path';
import os from 'node:os';

/**
 * Normalize a workspace or scope path to the host's native form before it is
 * used as a process cwd, an evidence root, or a policy scope.
 *
 * Contracts are portable JSON, so they may declare POSIX paths (e.g. "/tmp/ws").
 * On Windows that is not a valid cwd - spawn() throws ENOENT - and it never
 * matches the real filesystem paths the snapshot / evidence layers observe
 * (which are native, e.g. "C:\\Users\\...\\Temp\\ws"). We map the well-known
 * "/tmp" and "/temp" prefixes to the host temp dir, convert separators, and
 * resolve to an absolute path. On POSIX hosts the path is returned as-is
 * (resolved to absolute). The function is idempotent.
 */
export function normalizeHostPath(p: string): string {
  if (!p) return p;
  let s = p;
  if (process.platform === 'win32') {
    if (s === '/tmp' || s.startsWith('/tmp/')) {
      s = s.replace(/^\/tmp/, os.tmpdir());
    } else if (s === '/temp' || s.startsWith('/temp/')) {
      s = s.replace(/^\/temp/, os.tmpdir());
    }
    s = s.replace(/\//g, '\\');
  }
  return path.resolve(s);
}
