-- ============================================================
-- Personal Agent OS - migration 0002: per-run frozen contracts
-- (ADR-005). Enables browser-driven approval without weakening the
-- R3/R4 risk gate: the cockpit reads the frozen copy (server stays
-- read-only) and delegates the actual mutation to the CLI via a
-- child process. The contract source of truth remains @paos/contracts;
-- this table is a read-only-at-approval-time copy keyed by run id.
-- ============================================================
CREATE TABLE IF NOT EXISTS run_contracts (
  run_id        TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  contract_hash TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
