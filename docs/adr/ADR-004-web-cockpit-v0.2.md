# ADR-004: Web cockpit v0.2 as a local, read-mostly control surface

- **Status:** proposed
- **Date:** 2026-10-30

## Context

The kernel has a CLI-only surface: `init / status / run / approve / approvals / backup /
restore / migrate / doctor / evals / plugin-inspect`. There is no HTTP layer and no front
end at all. The recorded goal for "v0.2" is a cockpit showing the 14-state task machine,
the human approval queue, and the contracts behind each run.

Two facts force the shape of this decision:

1. **The cockpit is a control surface, not a dashboard.** `paos approve` is the exit from
   the R3/R4 risk gate (a human-confirmation token), and `paos run` launches real agent
   CLIs (`codex` / `claude` / `gemini` / `qwen`, all verified present) on the user's
   machine. Exposing either over HTTP creates a local privilege-escalation surface that
   does not exist today.
2. **Approval is not a bare database write.** `cmdApprove` requires `--contract <file>`
   because approving resumes the chain. A browser holds no contract file, so the
   approval semantics cannot be assumed; they must be decided, not implemented by
   default.

A stack review was performed on 2026-10-30 (see
[reviews/2026-10-30-web-cockpit-stack-review.md](../reviews/2026-10-30-web-cockpit-stack-review.md)).
It rejected the originally proposed zero-dependency `node:http` shape for the
write-capable service and found that the sequencing itself was the larger error.

## Options

1. Zero-dependency: Node built-in `node:http` + Vanilla TS + Vite.
2. Hono + React + Vite.
3. Node built-in `node:http` + React + Vite.
4. **Sequenced:** v0.1 = CLI `--json` + self-contained static HTML board (no server);
   v0.2 = Hono service layer + Vanilla TS view layer + typed DTO boundary.

## Decision

Option 4. Ship the board first as a server-less artefact, then build the service only
once live refresh or browser-side approval is proven to be needed.

When the service is built: **Hono** on `@hono/node-server` (not hand-rolled
`node:http`) for the transport layer, **Vanilla TS + Vite** for the view layer, and a
**typed DTO package** (`@paos/api`) between them so that neither the HTTP layer nor the
view framework is coupled to the database schema. The service opens the database
**read-only**; all mutations are executed by spawning the existing CLI as a child
process, so the server never holds the write lock and never runs a dispatch inside its
own event loop. The service binds **127.0.0.1 only** and authenticates with the existing
`installation.secret` mechanism, validating `Host` and rejecting cross-origin requests.
Contract *editing* is out of scope for v0.2: the contract's source of truth is
`@paos/contracts`, and a browser-side editor would fork it outside the reach of
`drift-check`.

React is deferred until measurable thresholds are met: more than three screens with
shared state, browser-side contract editing, optimistic updates after approval, streaming
faster than ~1 Hz, or more than one front-end maintainer.

## Consequences

- Positive: the transport layer stops being bespoke adversarial-facing code, while the
  domain layer keeps zero new runtime dependencies; the read-only split means the CLI
  and the cockpit cannot corrupt each other's state; the framework decision is informed
  by real usage instead of by assumption; the server-less v0.1 is deletable in one
  command if it proves sufficient.
- Negative: one new runtime dependency tree (hono + @hono/node-server) must clear the
  `pnpm audit --audit-level high` hard CI gate; the front end gains a build step, so the
  CI build now includes it; the DTO layer is duplicated work that a direct-to-rows API
  would not need, and it must be kept in sync deliberately (extend `drift-check` to
  cover it); approving from the browser may still require the CLI to resume a chain,
  which is a UX compromise that remains open until the run → `input_ref` → contract
  path is traced.

## Test anchors

- API contract tests: vitest against a real `listen(0)` server over `fetch` — no HTTP
  client dependency. Assert 401 without a valid token, 403 on a foreign `Host` header,
  400 on an over-sized body, and 200 on an authorised read.
- Read-only enforcement: the service's database handle rejects a write; a test asserts
  that a mutation attempt through the service fails while the CLI still succeeds.
- Dispatch isolation: a test asserts the HTTP server still answers requests while a
  child-process dispatch is in flight (guards against OD2).
- Unknown-value tolerance: a fixture task carrying an unrecognised status renders as
  "unknown" rather than crashing the board (guards against the hand-copied-drift class
  of defect).
- CI must build the front end and pass `pnpm audit --audit-level high` against
  `registry.npmjs.org` with the new dependency present.

## Progress

- **2026-10-30 — Alt.0 implemented.** `paos dashboard [--out FILE]` renders a
  self-contained, read-only HTML cockpit (no server, no `fetch`, no external
  resources) from the SQLite DB. `paos status [--json]` / `paos approvals [--json]`
  expose the same snapshot as JSON. Source: `apps/cli/src/dashboard.ts`; tests:
  `apps/cli/test/dashboard.test.ts` (7 cases, incl. an HTML/script-injection escape
  guard). Verified end-to-end via the built CLI on a seeded DB. Full suite 276
  green, `pnpm -r typecheck` clean. The Alt.0 exit criterion ("is the cockpit worth
  building as a service?") can now be answered from real usage data.
- The decision to promote Alt.0 -> Alt.1 (Hono + Vanilla TS service) remains
  **proposed** pending that evidence. No server, no auth surface, and no contract
  editing were added, per the non-goals.
