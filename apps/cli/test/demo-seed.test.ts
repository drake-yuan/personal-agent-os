// The bundled SQLite in this environment is 3.51.2; lower the runtime gate so
// the test suite can open the DB. Mirrors the existing runtime/db test setup.
process.env.PAOS_MIN_SQLITE_VERSION = '3.51.2';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate } from '@paos/db';
import { seedDemoCockpit } from '../src/demo-seed.js';
import { buildCockpitSnapshot } from '../src/dashboard.js';
import { validateCockpitSnapshot, COCKPIT_DISTRIBUTION_ENUMS } from '@paos/api';

describe('seedDemoCockpit (P1-6)', () => {
  it('covers every task-machine state and a non-empty approval queue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paos-demo-seed-'));
    try {
      const db = openDatabase(join(dir, 'paos.db'));
      migrate(db);
      seedDemoCockpit(db);
      const snap = buildCockpitSnapshot(db, dir);
      db.close();

      // One row per canonical state -> the 14-state machine is fully visible.
      expect(snap.tasks.length).toBe(COCKPIT_DISTRIBUTION_ENUMS.tasksByStatus.length);
      const statuses = new Set(snap.tasks.map((t) => t.status));
      for (const s of COCKPIT_DISTRIBUTION_ENUMS.tasksByStatus) {
        expect(statuses.has(s)).toBe(true);
      }
      // Workflow runs and dispatch intents are spread across several states.
      expect(snap.summary.runCount).toBeGreaterThanOrEqual(5);
      expect(snap.summary.dispatchCount).toBeGreaterThanOrEqual(4);
      // The human approval queue is non-empty, including an R4 that needs a contract.
      expect(snap.summary.pendingApprovalCount).toBeGreaterThanOrEqual(3);
      const risks = new Set(snap.approvals.map((a) => a.risk));
      expect(risks.has('R4')).toBe(true);
      // The snapshot is valid against the DTO (the drift guard would pass).
      expect(() => validateCockpitSnapshot(snap)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
