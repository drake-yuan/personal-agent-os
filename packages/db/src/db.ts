/**
 * SQLite open + runtime version gate (design Section 6.3 rule 6, P1-02).
 *
 * The runtime must be >= 3.51.3 (WAL-reset fix). Bundled node:sqlite
 * ships a pinned SQLite; if the bundled version is below the gate the
 * OS refuses to start unless the operator explicitly overrides via
 * PAOS_MIN_SQLITE_VERSION (documented escape hatch - never silent).
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// node:sqlite is an experimental Node builtin; some bundler/transformer
// chains (vitest/vite) cannot rewrite it, so the value is loaded via
// createRequire while types stay static.
const require = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = require('node:sqlite') as {
  DatabaseSync: typeof import('node:sqlite').DatabaseSync;
};

export const DEFAULT_MIN_SQLITE_VERSION = '3.51.3';

export class SqliteVersionError extends Error {
  constructor(actual: string, required: string) {
    super(
      `SQLite runtime ${actual} is below the required ${required} ` +
      `(WAL-reset fix). Refusing to start. Set PAOS_MIN_SQLITE_VERSION to override explicitly.`,
    );
    this.name = 'SqliteVersionError';
  }
}

export function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  return row.v;
}

/** Compare dotted versions: -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function minRequiredVersion(): string {
  return process.env.PAOS_MIN_SQLITE_VERSION ?? DEFAULT_MIN_SQLITE_VERSION;
}

/** Open a DB file (or :memory:) enforcing the version gate. */
export function openDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  const version = sqliteVersion(db);
  const required = minRequiredVersion();
  if (compareVersions(version, required) < 0) {
    db.close();
    throw new SqliteVersionError(version, required);
  }
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}
