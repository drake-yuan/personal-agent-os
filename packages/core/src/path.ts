import path from 'node:path';
import os from 'node:os';

/**
 * A host-specific path alias. Contracts are portable JSON and may declare a
 * workspace / scope path authored on a different machine (e.g. a macOS
 * `/Users/drake/projects/ws`). When that contract is executed on another host
 * (e.g. Windows `C:\Users\DRAKE\projects\ws`) the snapshot and evidence layers
 * observe native paths that never match the declared prefix, so scope checks
 * and cwd resolution silently fail. An alias table rewrites the foreign prefix
 * to the native one before the OS-specific normalization runs.
 *
 * `from` is matched as a full path segment (so `/Users/drake` does not swallow
 * `/Users/drake-x`), and the longest `from` wins so a more specific alias can
 * override a parent.
 */
export interface PathAlias {
  /** Foreign / logical prefix as it appears in the portable contract. */
  from: string;
  /** Native replacement on this host. */
  to: string;
}

/**
 * Rewrite a foreign/logical path prefix to the host-native one using an alias
 * table. Pure and idempotent: once a path has been rewritten it no longer
 * starts with any `from`, so a second pass is a no-op. Returns the input
 * unchanged when no alias applies or `aliases` is empty/undefined.
 */
export function mapPathAlias(p: string, aliases?: readonly PathAlias[]): string {
  if (!p || !aliases || aliases.length === 0) return p;
  const ordered = [...aliases].sort((a, b) => (b.from?.length ?? 0) - (a.from?.length ?? 0));
  for (const a of ordered) {
    const from = a.from ?? '';
    if (!from) continue;
    if (p === from) return a.to ?? p;
    const sep = p[from.length];
    // Only rewrite at a segment boundary, never mid-name.
    if (sep === '/' || sep === '\\') {
      return (a.to ?? '') + p.slice(from.length);
    }
  }
  return p;
}

/**
 * Normalize a workspace or scope path to the host's native form before it is
 * used as a process cwd, an evidence root, or a policy scope.
 *
 * Contracts are portable JSON, so they may declare POSIX paths (e.g. "/tmp/ws").
 * On Windows that is not a valid cwd - spawn() throws ENOENT - and it never
 * matches the real filesystem paths the snapshot / evidence layers observe
 * (which are native, e.g. "C:\\Users\\...\\Temp\\ws"). We first apply any host
 * alias table (cross-machine prefix rewrite), then map the well-known "/tmp"
 * and "/temp" prefixes to the host temp dir, convert separators, and resolve to
 * an absolute path. On POSIX hosts the path is returned as-is (resolved to
 * absolute). The function is idempotent.
 */
export function normalizeHostPath(p: string, aliases?: readonly PathAlias[]): string {
  if (!p) return p;
  let s = mapPathAlias(p, aliases);
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
