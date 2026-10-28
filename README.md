# Personal Agent OS

**A local-first operating-system kernel for your personal agent fleet: turn goals into tasks, delegate tasks to the agents you already run (Codex / Claude Code / Gemini / WorkBuddy...), verify results with contracts and three-layer deterministic checks, and let a weekly review loop make the next round better.**

This is **not another agent framework**. It is the scheduling, governance, and memory layer that sits *on top of* the agents you already have.

> **v0.1 positioning:** an orchestrator of *trusted local user operations*. It is **not** a sandboxed runtime for untrusted agents or third-party plugins. See [Known limitations](#known-limitations-v01--read-before-trusting).

[![CI](https://github.com/drake-yuan/personal-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/drake-yuan/personal-agent-os/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-%3E%3D9-orange.svg)](https://pnpm.io)

---

## Table of contents

- [Why](#why)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [API documentation](#api-documentation)
- [Testing and quality gates](#testing-and-quality-gates)
- [Project status](#project-status)
- [Known limitations](#known-limitations-v01--read-before-trusting)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Why

You already run an agent fleet. What is missing is the operating system around it:

- **Goals decay into nothing.** Tasks live in five tools; nothing enforces a definition of done.
- **Agents claim completion.** "Done!" is not evidence. Nothing independently verifies.
- **Irreversible actions are one prompt away.** Money movement, deletion, and external sends need a human gate.
- **Interrupted runs vanish.** A crashed dispatch becomes a duplicate task, or a silently lost one.

PAOS is a thin kernel that does exactly five things: **goals / tasks / state / evidence / approvals**. Agent capability is attached through adapters, and every delegation carries a machine-verifiable definition of done.

Three properties make it different from "yet another agent runner":

1. **A task is only done when the Verifier says so** - an executor reporting `completed` is an *observation*, never a state transition. `done` requires `accepted_at` + `evidence_refs` + `verification_report_ref`.
2. **Deterministic verification, not vibes** - three layers (protocol / product / business) executed by a whitelisted checker registry. No arbitrary shell or JS in verification.
3. **Honest failure semantics** - a dispatch timeout becomes `unknown_outcome`, never a silent `failed`. Exactly-once delivery is never promised unilaterally.

## Features

- **14-state task machine** with a complete, tested transition matrix (T1-T37, 36 legal edges with guards). Illegal transitions are rejected, not warned about.
- **Single risk model R0-R4** with deny-first classification: unknown actions default to the highest risk.
- **Approval gate** for high-impact actions: R3 requires a human decision; R4 additionally requires a one-time token and nonce, with action/scope binding, consume-once semantics, and supersede support. Gated runs are released through `paos approve`, which re-verifies the binding before the gated execution starts.
- **Contract v1.1 / Result v1.1** JSON schemas (`additionalProperties: false`) served from a `paos://` schema store with a drift check that keeps enums, DDL, and schemas in lockstep.
- **Dispatch outbox** with six states including `unknown_outcome`; intents are committed *before* any network call.
- **Worker lease + compare-and-swap** with adapter-derived heartbeat thresholds; double workers cannot double-execute.
- **Three-layer verification engine** (protocol / product / business) driven by a whitelist of 9 deterministic checkers.
- **Full-tree snapshot escape detection** (symlink resolution, path traversal, case-folding).
- **SQLite persistence** with a versioned migration ledger (checksums, idempotent replay, rollback API) and append-only audit triggers.
- **Local-first API** with an explicit auth model: `installation_secret` + Bearer token + Host/Origin/Sec-Fetch-Site checks. Never bound to `0.0.0.0` by default.
- **Zero-secret demo adapter** - the entire task loop runs offline against recorded fixtures, no API keys required.
- **Real CLI adapters for Codex and Claude Code** (G2). The objective travels over stdin, never argv; no vendor permission-bypass flag is ever passed; a non-zero exit is a task failure rather than a transport failure; and credentials are never probed implicitly - `--auth` opts into running the vendor status command.
- **Deterministic eval gates** over a 12-scenario matrix (`paos evals` / `pnpm evals:deterministic`), including a coverage gate so a scenario with zero cases cannot pass vacuously.

## Requirements

| Component | Minimum | Notes |
|---|---|---|
| Node.js | >= 22.5 | uses `node:sqlite` (experimental, no native deps) |
| pnpm | >= 9 | workspace package manager |
| SQLite runtime | >= 3.51.3 | WAL-reset fix; see [Configuration](#configuration) for the escape hatch |
| OS | Linux / macOS / Windows | CLI adapters are `unconfined` on Windows (see Known limitations) |

## Installation

```bash
git clone https://github.com/drake-yuan/personal-agent-os.git
cd personal-agent-os/code
pnpm install
pnpm build
```

Or run the CLI directly from the repository without a global install:

```bash
node apps/cli/dist/index.js help
```

## Usage

Quick start - no API keys needed:

```bash
# 1. Run the full deterministic test suite
pnpm -r test

# 2. First-run initialization: creates data/paos.db, installation.secret (mode 0600), applies migrations
node apps/cli/dist/index.js init --data-dir=data

# 3. Inspect the local installation
node apps/cli/dist/index.js status --data-dir=data

# 4. Execute the core chain end to end (demo adapter, no API keys).
#    `paos` works after `pnpm install` links the workspace bin; the explicit
#    `node apps/cli/dist/index.js` form is equivalent.
paos run demo/contracts/software-change-task.json --data-dir=data
# Execute with a real local agent instead of the replayed demo:
paos run demo/contracts/software-change-task.json --adapter codex-adapter --data-dir=data

# 5. Diagnose adapters (five-level health check, incl. the real CLI ones)
node apps/cli/dist/index.js adapter doctor
node apps/cli/dist/index.js adapter doctor codex-adapter --auth

# 6. Inspect a plugin manifest (install phase 1: zero code execution)
node apps/cli/dist/index.js plugin inspect demo/manifest.json

# 7. Run the deterministic eval gates (12-scenario matrix)
#    The report lands in <data-dir>/eval-runs. Both entry points run the
#    same suite, so they can never report different verdicts.
node apps/cli/dist/index.js evals --data-dir=data
# equivalent: pnpm evals:deterministic   (report lands in ./data/eval-runs)

# 8. Run the enum/DDL/schema drift check
pnpm drift:check

# R3/R4 work parks on a human gate; this is how it is released
node apps/cli/dist/index.js run demo/contracts/software-change-gated.json --data-dir=data
node apps/cli/dist/index.js approvals --data-dir=data
node apps/cli/dist/index.js approve <approval-id> \
  --contract demo/contracts/software-change-gated.json --token human-confirmed --by you

# 9. Release operations: backup, restore, upgrade (gate G4)
paos backup --data-dir=data                 # snapshot paos.db + secret (+ manifest)
paos backup --data-dir=data --out ./release/backup
paos restore <backup-dir> --data-dir=data   # restore a snapshot (manifest-verified)
paos migrate --data-dir=data                # apply pending schema migrations
                                             # (takes a checkpoint backup first)

```
```

The demo adapter replays recorded fixtures, so the first task loop
(Inbox -> contract -> dispatch -> three-layer verification -> Review)
runs entirely offline.

Selecting a real adapter (`--adapter codex-adapter | claude-code-adapter`)
dispatches to the real CLI and verifies against **real workspace evidence**:
artifact hashes are read from the workspace, changed paths come from `git`,
and the exit code is the one the process actually returned. Evidence that
cannot be observed fails closed - it is never filled in from fixtures, and an
undeterminable diff is reported as unverifiable rather than as "no changes".

A typical task lifecycle looks like this:

```
goal -> task (planned) -> contract v1.1 attached
     -> approved (R0-R2) or gated (R3/R4, human decision)
     -> dispatched via outbox -> executor observes -> reported
     -> three-layer verification -> verdict
     -> accepted (done, with evidence) | rejected | needs_human
```

> **Windows / sandboxed shells:** if your shell sandbox blocks writes to the system temp directory, point `TEMP`/`TMP` inside the workspace before running tests (vitest SSR cache).

## Configuration

All configuration is environment variables or CLI flags. Nothing is read from the network.

| Variable / flag | Default | Purpose |
|---|---|---|
| `--data-dir` | `data` | Location of `paos.db` and `installation.secret` |
| `PAOS_MIN_SQLITE_VERSION` | `3.51.3` | Minimum accepted SQLite runtime version. Escape hatch for runtimes bundling an older SQLite (e.g. Node 22.22 bundles 3.51.2). Lowering this accepts the WAL-reset risk explicitly - it is never bypassed silently. |
| `PAOS_API_HOST` | `127.0.0.1` | Local API bind address. Remote access is a separate security mode (v0.2+); never bind `0.0.0.0` by default. |
| `TEMP` / `TMP` / `TMPDIR` | system temp | Point inside the workspace on sandboxed shells (see note above) |

The `installation.secret` file (mode 0600) is generated on first run and is the root credential for the local API. It is ignored by git and must never be committed.

## Architecture

```
apps/cli         paos CLI: init / status / run / evals / adapter doctor / plugin inspect
packages/
  contracts      single source of truth: enums, JSON schemas, checker registry, paos:// store
  core           task state machine (T1-T37), approval gate (R0-R4), risk classification, fleet registry
  db             SQLite open + version gate, migration runner, backup API
  runtime        dispatch outbox, worker lease, provider status map, three-layer verify, snapshot
  policy         structured action policy, data-transfer gate
  adapters       AgentAdapter interface, registry, doctor diagnostics, zero-secret demo adapter
  evidence       artifact store (opaque IDs, sha256, size caps)
  evaluation     deterministic gates + 12-scenario matrix
schemas/         canonical paos:// JSON schemas
migrations/      versioned SQL migrations (0001 = v2.0 baseline, 22 tables)
workflows/       linear workflow definitions (v0.1: five step kinds, no DAG)
skills/          SKILL.md convention + PAOS extension fields
domains/         domain packs (declaration-only, no arbitrary code)
demo/            synthetic fixtures (Alex Chen / Acme / Project Aurora - all fictional)
evals/           deterministic case matrix
openapi.yaml     REST contract (v1)
events.schema.json  SSE event contract
docs/            ADRs and the open-source playbook
```

In one paragraph: `core` owns every state transition - it is the only module allowed to change state. `runtime` dispatches through an outbox committed **before** any network call, derives status through a single `mapProviderStatus`, and verifies through three deterministic layers. `policy` decides on structured action type + resource scope + data classification + **enforced** (never declared) adapter capabilities. `adapters` can only report observations - there is deliberately no `completeTask` method; task `done` is written by the Verifier only.

Design decisions are recorded as ADRs in [`docs/adr/`](docs/adr/README.md).

## API documentation

The local REST API is specified in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1), and the server-sent event stream in [`events.schema.json`](events.schema.json).

> **Spec only - not implemented in v0.2.** No HTTP server ships yet; `apps/` contains the CLI only. Treat `openapi.yaml` as the design contract for the v0.2 server, and use `paos` as the single entry point today.

**Authentication model (v0.1):**

- Every request requires the `installation_secret` (Bearer token).
- Host / Origin / `Sec-Fetch-Site` headers are validated to block DNS-rebinding and CSRF.
- High-risk actions (R3/R4) additionally require a human approval with a one-time nonce bound to the exact action and resource scope.

**Core resources:**

| Resource | Description |
|---|---|
| `GET /v1/status` | Installation health, migration ledger head, adapter states |
| `POST /v1/tasks` | Create a task from a contract |
| `POST /v1/tasks/{id}/dispatch` | Commit a dispatch intent (outbox) |
| `GET /v1/tasks/{id}` | Task state + evidence refs + verification report |
| `POST /v1/approvals` | Submit a human decision (approve / deny / supersede) |

## Testing and quality gates

```bash
pnpm -r test              # 221 tests / 26 files (deterministic suite)
pnpm -r typecheck         # strict tsc
pnpm drift:check          # enums = DDL docs = JSON schemas (single-source check)
pnpm evals:deterministic  # 12/12 scenario gates
pnpm -r build             # emit dist/ for all packages
```

CI (`.github/workflows/ci.yml`) runs the full chain on every PR:
build -> test -> typecheck -> drift check -> deterministic evals -> SQLite version assertion -> gitleaks secret scan -> `pnpm audit`.

The suite covers, among others: every legal and illegal state-machine edge, approval replay / supersede / expiry, five outbox fault injections, migration idempotency and audit triggers, snapshot escape scenarios, fail-closed schema validation, and CLI smoke runs against a real database.

## Project status

v0.2 engineering baseline (kernel + contracts + runtime + governance). Gates G0 and G1 of the release plan are closed. Real CLI adapters (codex / claude-code) are wired into `paos run --adapter <id>` and are verified against real workspace evidence rather than demo fixtures.

The **WorkBuddy cloud adapter is implemented and selectable** (`--adapter workbuddy`, also `paos adapter doctor workbuddy`), but gate **G3 remains open**: it needs a real endpoint plus an OAuth token from the reviewed app, so it fails closed and enforces nothing until those exist. It is a remote executor, so it guarantees only `structured_output` and `external.send` - it has no local filesystem access, and contracts requiring `fs.*` are correctly refused rather than silently attempted.

The roadmap and release gates are documented in [`docs/OPEN_SOURCE_PLAYBOOK.md`](docs/OPEN_SOURCE_PLAYBOOK.md).

## Known limitations (v0.1 - read before trusting)

1. **No OS-level sandbox.** v0.1 is an orchestrator of trusted local operations. Real CLI adapters inherit whatever the vendor CLI enforces (Codex `-s` sandbox mode, Claude Code permission prompts); Personal Agent OS reports that honestly as `workspace-fs` and never creates a container. It also never passes a vendor "skip permissions" flag - Claude Code is told to auto-deny prompts instead. Contracts that need stronger isolation are refused rather than pretended-safe.
2. **No arbitrary third-party plugins.** Only `builtin` / `reviewed` adapters; install runs `inspect -> trust -> probe -> grant` with zero code execution during inspect, and there is no hot-loading.
3. **The WorkBuddy adapter cannot run real work yet (gate G3).** An adapter now exists and is selectable, but there is no published endpoint and no reviewed OAuth app, so `probe()` reports `E_WORKBUDDY_NOT_CONFIGURED` and enforces nothing until `PAOS_WORKBUDDY_ENDPOINT` + `PAOS_WORKBUDDY_TOKEN` are set. It is also a *remote* executor: it enforces only `structured_output` and `external.send`, never local filesystem access, so contracts needing `fs.*` are correctly refused. Closing this needs the G3 gate (OAuth app review) - `handoff` mode is the documented fallback meanwhile.
4. **Evals prove determinism, not intelligence.** Passing cases show the control loop works - they are not evidence that "the agent got smarter".
5. **Single user, local-first, no accounts.** Remote access is a separate security mode (v0.2+), never `0.0.0.0` by default.
6. **SQLite runtime gate is 3.51.3** (WAL-reset fix). Node 22.22 bundles 3.51.2 - override explicitly with `PAOS_MIN_SQLITE_VERSION` if you accept the risk.
7. **Audit logs are append-only at the application layer** (SQLite triggers + append API + hash-chained export). A local OS administrator can still modify the database file directly; the tamper-evidence promise covers the application layer and detection capability only.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: manifest schemas, eval cases, domain-pack templates. The short version: determinism first, tests before merge, English comments, conventional commits (`feat(scope): ...` / `fix(scope): ...`) with a Cause/Impact body.

## Security

Report vulnerabilities via the process in [SECURITY.md](SECURITY.md). The threat/mitigation table there is part of the contract with users - it is updated when the model changes, not when it is convenient.

## License

Apache-2.0 ([LICENSE](LICENSE)). The patent grant is explicit. CLA policy will be settled before external contributions are accepted - the rules will not change retroactively.
