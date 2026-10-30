# Browser-side approval: the `run -> input_ref -> contract` trace

- **Date:** 2026-10-30
- **Status:** investigative note (resolves open decision **OD3** from
  [2026-10-30-web-cockpit-stack-review.md](./2026-10-30-web-cockpit-stack-review.md))
- **Scope:** can the read-only cockpit (ADR-004 Alt.1) ever perform `approve`, and if not, why?
- **Outcome:** approve from the browser is blocked by a *content-persistence gap*, not by a
  path-resolution problem. Deny is implementable today with no new machinery.

## Verdict (TL;DR)

| Question | Answer | Evidence |
|---|---|---|
| Does `approve` really require a contract, or only "to resume"? | It requires it **always**, even without resume — the gate checks the exact binding. | `packages/runtime/src/approvals.ts:163-168`, `:194-198` |
| Can the contract be recovered from the DB? | **No.** Only a one-way SHA-256 digest is stored. | `packages/runtime/src/pipeline.ts:433` |
| Is there a path to resolve (traversal risk)? | No — there is **no stored path at all**, so there is nothing to traverse. | grep for `writeFileSync` across `packages/runtime`, `packages/core` = none |
| Can the browser *deny*? | **Yes**, with no contract and no filesystem access. | `packages/runtime/src/approvals.ts:143-159` |
| Can the browser *approve*? | **No**, not without one of the options below. | this document |

## The traced path

1. **`paos run <contract>` reads the contract file and normalizes it.**
   `apps/cli/src/index.ts:501-503` — existence-checked, parsed, path-aliased
   (`normalizeContractPaths`), then handed to `runContract`.

2. **The runtime creates the run row and records `input_ref`.**
   `packages/runtime/src/pipeline.ts:433`:
   ```ts
   inputRef: `contract:${sha256(JSON.stringify(contract))}`,
   ```
   This is the **only** site that writes `input_ref` (confirmed: the sole `inputRef` write
   across `apps/` and `packages/`).

3. **`input_ref` is a content digest, not a location.** Nothing stores the contract body:
   the only `writeFileSync` call sites in the whole runtime/core/CLI are the static
   dashboard HTML, the `installation.secret`, and the backup manifest. `run_steps.input_ref`
   (nullable in `migrations/0001_init_v2.sql:190`) is never written.

4. **Nothing ever reads `input_ref` back.** There is no read-site comparing a supplied
   contract against the recorded digest, so today the value is *write-only metadata*.

5. **Approval consumes the contract for binding verification, not for dispatch.**
   `packages/runtime/src/approvals.ts`:
   - `:163-168` — hard `throw` when `input.contract` is absent for `decision === 'approved'`.
   - `:170` — `isSupersededByChange(approval, contract.objective, contract.requirements.scope_paths)`
     voids the approval if the contract's objective or scope changed since it was issued.
   - `:194-198` — `checkGate(approval, { action: contract.objective, resourceScope: contract.requirements.scope_paths })`
     verifies expiry, nonce, named decider, R4 token, and the exact binding.
   - `:215-220` — with no adapter the approval stays **approved but unconsumed** ("spendable")
     and the task returns to `running`; nothing is dispatched.

   The distinction that matters: the contract is **not** needed merely to resume execution
   (that needs `adapter` + `checkContext`). It is needed to prove that what is being approved
   is the same action and scope the approval was issued for.

## Why this is not the OD3 "path-resolution + traversal" problem

OD3 anticipated *"the server must locate the contract from the run's `input_ref` (a
path-resolution + traversal-safety problem)"*. The trace shows the premise does not hold:
`input_ref` holds `contract:<sha256>`, so there is no path to resolve and no stored body to
traverse to. The real gap is that **the contract is never persisted**, so the server has
nothing to reconstruct it from. This is a better problem to have (the traversal-safety
concern evaporates) but it is still blocking.

## Two side findings

1. **Stale DDL comment.** `migrations/0001_init_v2.sql:177` documents
   `input_ref TEXT NOT NULL, -- frozen run snapshot (contract + inputs)`. The implementation
   never froze anything; it stores a digest. The comment documents an intent that was never
   realized. Left untouched here — migrations may be integrity-checked, and editing it risks
   breaking verification for a cosmetic gain.
2. **The usage string over-promises, the runtime enforces.** `apps/cli/src/index.ts:594`
   prints `--contract <file>` as required, and `index.ts:602-606` treats it as optional. The
   *real* enforcement lives deeper, in `approvals.ts:163`. Anyone relaxing the CLI would not
   have realized how far the requirement reaches.

## Options for browser-side approve

| Option | What it means | Cost / risk |
|---|---|---|
| **A. Persist the frozen contract** | At run creation, write `<dataDir>/runs/<run_id>/contract.json` and repoint `input_ref` at it (keeping the sha256 as an integrity anchor). The server reconstructs the object and can run full approve + resume. | Real change: storage growth in `dataDir`, backup/restore must include the store, `input_ref` semantics shift from digest to location, and a contract may carry sensitive scope paths that now live next to the DB. Also needs migration thought. **This is the only option that unlocks true browser approve.** |
| **B. Browser uploads the contract** | The UI posts a contract file to the approve endpoint. | Rejected by ADR-004: it forks the source of truth outside `@paos/contracts` and outside `drift-check`. It also lets the browser author (or tamper with) the thing being approved — inverting the risk gate. |
| **C. Weaken to "record intent"** | Approve without binding verification, optionally reconcile later. | This **lowers the risk gate** (a safety property), not a UX detail. If ever chosen it must be a stated, reviewed decision — never a silent default. It would also break explicit user red lines (irreversible/high-impact actions must be human-confirmed). |

## Recommendation

Do **not** implement browser-side approve yet. Ship the parts that are safe and honest:

1. **Deny from the browser** — fully supported today (`:143-159`), needs only a named
   decider (`--by`, enforced at `:127-129`). Task -> `blocked`, run -> `paused`.
2. **A "resume in terminal" affordance** — the cockpit's job queue can render the exact
   command the operator must run (`paos approve <id> --contract <path>`), since only the
   operator holds the contract. This keeps the human in the loop without pretending the
   browser can do it.
3. Gate **A** behind the Alt.1 -> accepted decision and real usage evidence, with its own
   ADR, because it changes `input_ref` semantics and the `dataDir` storage contract.

This stays consistent with ADR-004: write endpoints remained *gated*, and nothing here
adds a write surface. It converts OD3 from an open question into a recorded, traceable
decision with evidence.
