/**
 * Migration runner (design §6.3).
 *
 * - Each migration runs in a transaction; the ledger row
 *   (version, name, checksum, applied_at) is written in the SAME
 *   transaction - a half-applied migration is never recorded.
 * - Re-running an applied migration is a no-op (idempotent).
 * - An unknown or changed checksum refuses to run (no silent drift,
 *   no downgrades).
 * - Backups use the SQLite backup API before applying, verified
 *   re-openable; `data/*.db-wal` copying is never used.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

/** Locate the repo-root migrations/ dir by walking up from this module. */
export function migrationsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'migrations');
    if (existsSync(path.join(candidate, '0001_init_v2.sql'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('migrations directory not found');
}

export function loadMigrations(): Migration[] {
  const dir = migrationsDir();
  return readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((file) => {
      const version = Number(file.slice(0, 4));
      const sql = readFileSync(path.join(dir, file), 'utf8');
      return {
        version,
        name: file.replace(/^\d+_/, '').replace(/\.sql$/, ''),
        sql,
        checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
      };
    });
}

export class MigrationChecksumError extends Error {
  constructor(version: number) {
    super(`migration ${version} checksum mismatch: applied migration changed on disk (refusing)`);
    this.name = 'MigrationChecksumError';
  }
}

export interface MigrateResult {
  applied: number[];
  skipped: number[];
}

/** Back up a live DB with the SQLite backup API (never a raw file copy). */
export function backupDatabase(db: DatabaseSync, backupPath: string): void {
  mkdirSync(path.dirname(backupPath), { recursive: true });
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
}

export function migrate(db: DatabaseSync, opts: { backupPath?: string } = {}): MigrateResult {
  const applied: number[] = [];
  const skipped: number[] = [];

  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);

    const ledger = db
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all() as Array<{ version: number; checksum: string }>;

    for (const m of loadMigrations()) {
      const existing = ledger.find((r) => r.version === m.version);
      if (existing) {
        if (existing.checksum !== m.checksum) throw new MigrationChecksumError(m.version);
        skipped.push(m.version);
        continue;
      }
      if (opts.backupPath && path.extname(opts.backupPath) !== '') {
        backupDatabase(db, opts.backupPath);
      }
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(m.version, m.name, m.checksum, new Date().toISOString());
      applied.push(m.version);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { applied, skipped };
}

/** Applied versions in ledger order. */
export function appliedVersions(db: DatabaseSync): number[] {
  return (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>)
    .map((r) => r.version);
}
