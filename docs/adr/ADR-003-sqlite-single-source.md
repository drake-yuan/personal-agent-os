# ADR-003: SQLite (WAL) as the only structured source of truth

- **Status:** proposed
- **Date:** 2026-10-25

## Context

Local-first, single-user, zero-ops. Structured state (tasks, runs, dispatches,
approvals, audit) must survive crashes; Markdown + YAML carry skills, decisions
and context.

## Options

1. SQLite (WAL) + Markdown/YAML
2. Plain Markdown only
3. Postgres even locally

## Decision

SQLite in WAL mode with `foreign_keys = ON`; migration ledger with checksums;
backups via the SQLite backup API (`VACUUM INTO`), never raw `.db` copies that
ignore the WAL. Runtime gate: SQLite ≥ 3.51.3 (WAL-reset fix).

## Consequences

- Positive: transactional state transitions; append-only audit triggers; no
  server process.
- Negative: version gate can refuse startup on older bundled drivers (explicit
  `PAOS_MIN_SQLITE_VERSION` override exists and is documented).

## Test anchors

Migration idempotency, checksum-mismatch refusal, append-only trigger tests,
backup re-openability test, version-gate test.
