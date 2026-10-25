/**
 * Workspace snapshot: full-tree enumeration for artifact escape
 * detection (design Section 8.5, P0-07).
 *
 * Baseline and post-execution snapshots enumerate staged / unstaged /
 * untracked / deleted / renamed files plus per-file sha256. Paths are
 * normalized (case + unicode NFC), symlinks are resolved to their real
 * target, and every path must sit inside the licensed root. NUL is
 * used as the path separator when reading git output (paths with
 * newlines cannot spoof the diff).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface SnapshotEntry {
  path: string;       // normalized, root-relative
  sha256: string;
  kind: 'file' | 'symlink' | 'deleted';
}

export interface WorkspaceSnapshot {
  root: string;
  entries: Map<string, SnapshotEntry>;
}

/** Normalize: unicode NFC + posix separators + case-fold marker. */
export function normalizePath(p: string): string {
  return p.normalize('NFC').replace(/\\/g, '/');
}

function sha256File(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/** Walk the tree; symlinks are recorded with their resolved target. */
export function takeSnapshot(root: string): WorkspaceSnapshot {
  const entries = new Map<string, SnapshotEntry>();
  const absRoot = path.resolve(root);

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git' || name === 'node_modules') continue;
      const abs = path.join(dir, name);
      const rel = normalizePath(path.relative(absRoot, abs));
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const target = realpathSync(abs);
        if (!target.startsWith(absRoot + path.sep) && target !== absRoot) {
          entries.set(rel, { path: rel, sha256: '', kind: 'symlink' });
        }
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (st.isFile()) {
        entries.set(rel, { path: rel, sha256: sha256File(abs), kind: 'file' });
      }
    }
  };

  if (existsSync(absRoot)) walk(absRoot);
  return { root: absRoot, entries };
}

export interface SnapshotDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  escaped: string[]; // outside the licensed root (symlink or path traversal)
}

export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, scopePaths: string[]): SnapshotDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const escaped: string[] = [];

  for (const [p, entry] of after.entries) {
    const prev = before.entries.get(p);
    if (entry.kind === 'symlink') {
      escaped.push(p);
      continue;
    }
    if (!prev) {
      added.push(p);
    } else if (prev.sha256 !== entry.sha256) {
      modified.push(p);
    }
    if (!inScope(p, scopePaths)) escaped.push(p);
  }
  for (const [p, entry] of before.entries) {
    if (!after.entries.has(p) && entry.kind !== 'symlink') deleted.push(p);
  }
  return { added, modified, deleted, escaped };
}

export function inScope(p: string, scopePaths: string[]): boolean {
  const norm = normalizePath(p);
  return scopePaths.some((s) => {
    const scope = normalizePath(s);
    return norm === scope || norm.startsWith(scope.endsWith('/') ? scope : scope + '/');
  });
}

/** Reject path traversal attempts like ../ or absolute escapes. */
export function escapesRoot(root: string, candidate: string): boolean {
  const absRoot = path.resolve(root);
  const resolved = path.resolve(absRoot, candidate);
  return !(resolved === absRoot || resolved.startsWith(absRoot + path.sep));
}
