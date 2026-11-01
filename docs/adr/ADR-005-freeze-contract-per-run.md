# ADR-005: Persist a frozen contract per run to enable browser approval

- **Status:** proposed
- **Date:** 2026-11-01
- **Supersedes / extends:** ADR-004 (Web cockpit v0.2); resolves the OD3 / §5.P1-3 open question.

## Context

ADR-004 left the **approve** half of the cockpit mutation surface gated, because
approving requires the contract file (`packages/runtime/src/approvals.ts:163-168`:
the binding cannot be verified without `contract.objective` + `requirements.scope_paths`,
and `isSupersededByChange` voids a changed one at `:170`). The OD3 trace
(`docs/reviews/2026-10-30-browser-approval-trace.md`) established why:

- `input_ref` is written **once**, at `packages/runtime/src/pipeline.ts:433`, as
  `contract:${sha256(JSON.stringify(contract))}` — a **one-way content digest**, not a
  path and not a stored snapshot.
- Nothing reads `input_ref` back, and no contract body is ever persisted. So the server
  cannot locate the contract to resume an approval; the browser holds no contract file.
- Three options were recorded in the trace: (A) persist the frozen contract per run and
  repoint `input_ref`; (B) let the browser upload the contract (rejected — forks the
  source of truth outside `@paos/contracts`/drift-check); (C) weaken to "record intent"
  (rejected — lowers the risk gate itself).

`deny` needs no contract (`approvals.ts:143-159`) and is already exposed via the cockpit
(`/api/actions/deny`, P1-2 safe slice). This ADR decides **Option A** for the `approve`
half, so the cockpit can drive the full approval queue without weakening the gate.

## Decision

Persist a frozen copy of the contract at the moment a run is created, and make
`input_ref` resolvable to it. The contract's source of truth stays `@paos/contracts`;
the cockpit only ever *reads* the frozen copy and delegates the actual mutation to the
CLI via a child process (ADR-004 P1-2), keeping the server read-only.

### Schema

New migration `migrations/0002_run_contracts.sql` (auto-discovered by the versioned
runner in `packages/db/src/migrate.ts`, which globs `^\d+_.*\.sql$`):

```sql
CREATE TABLE IF NOT EXISTS run_contracts (
  run_id        TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  contract_hash TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
```

### Freeze point (`pipeline.ts:433`)

At the existing freeze site, additionally write the contract JSON to `run_contracts`
(run_id, sha256(contract_json), contract_json, now). Leave `input_ref` as
`contract:<sha256(JSON.stringify(contract))>` — the digest is unchanged, it is now
*resolvable* to a stored row instead of being opaque.

### Storage hardening

`contract_json` is written with mode `0600`, mirroring `installation.secret`
(`apps/cli/src/index.ts:116-117`). A contract discloses `requirements.scope_paths`
(filesystem layout) but no credentials; the risk is local-only disclosure, already
bounded by the loopback + bearer model.

### New approval path: `--contract-hash`

`cmdApprove` gains an optional `--contract-hash <hash>` flag:

1. Look up `run_contracts` by `run_id` (from the approval) and `contract_hash`.
2. Re-validate the stored `contract_json` against the **current** `@paos/contracts`
   schema. If it fails, reject and instruct the operator to re-supply `--contract <file>`
   (schema has drifted since the run was frozen; the frozen copy is no longer trustworthy).
3. Otherwise proceed exactly as `--contract <file>` would — the binding is still verified
   against `contract.objective` + `scope_paths`; nothing about the risk gate changes.

Because validation is re-run at approval time, the frozen copy can never silently bypass
a tightened schema.

### Backward compatibility

Runs frozen before this migration have `input_ref = contract:<sha256>` but no
`run_contracts` row. For those, `--contract-hash` falls back to requiring `--contract
<file>` (today's behaviour). No data backfill is needed; old approvals simply keep using
the file path.

### Cockpit wiring (unblocks `/api/actions/approve`)

Once ADR-005 is implemented, the cockpit's `/api/actions/approve` route (currently 403,
see `apps/cli/src/auth.ts`) can:

1. Read `input_ref` for the approval's run (server is read-only, this is a SELECT).
2. Spawn `paos approve <id> --contract-hash <hash>` as a child process, behind the same
   bearer + loopback + Host-pin + rate-limit guards as every other route.

The server still never holds the write lock and never imports `runContract`.

## Consequences

- Positive: the full approval queue becomes browser-actionable without weakening the R3/R4
  risk gate; the contract source of truth stays in `@paos/contracts` (drift-check still
  applies); the server stays read-only + child-process; backward compatible with no
  backfill.
- Negative: a copy of every run's contract is now at rest in `dataDir` (small storage
  growth, 0600 bounded); the migration is a new CI gate — `drift-check` covers enums vs
  DDL docs + schema, so `run_contracts` must be reflected in `ddl-doc.json` (or explicitly
  exempted) to keep the gate green; re-validation at approval time adds one schema check to
  the approve latency (negligible).
- The OD2 / event-loop isolation guarantee (server answers reads while a child dispatch is
  in flight) is unchanged — `paos approve` with an adapter resumes a chain as a child
  process, which is exactly the already-tested pattern.

## Test anchors

- Freeze: a unit test asserts that creating a run writes a `run_contracts` row whose
  `contract_hash` equals `sha256(contract_json)` and matches `input_ref`'s digest.
- Migration: `0002_run_contracts.sql` is idempotent and the runner applies it without
  bumping `user_version` errors.
- `--contract-hash` rejects a stored contract that no longer validates against the current
  schema, and succeeds when it does (parity with `--contract <file>`).
- End-to-end (demo mode): the cockpit's approve action drives a child `paos approve
  --contract-hash` and the run's `input_ref` resolves to the frozen copy.

## Status note

Proposed. Not yet implemented. ADR-004's `/api/actions/approve` returns 403 with a
structured `cliCommand` until this ADR is accepted and implemented.
