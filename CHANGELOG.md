# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Core chain orchestration** `runContract()` (packages/runtime): contract ->
  policy -> task -> outbox dispatch -> observation -> three-layer verification
  -> verdict -> done. `done` is reachable only through `acceptTask()`.
- **Persistence layer** (packages/db): repositories for tasks, workflow runs,
  dispatch intents and approvals. UPDATE statements are assembled from a
  per-table column allowlist so no caller-supplied identifier reaches SQL text.
- `paos run <contract.json>` - executes the chain against the demo adapter and
  persists every state change.
- `resolveApproval()` (packages/runtime) - the exit from the risk gate. It
  re-verifies the action/scope binding before release, requires an explicit
  token for R4, consumes the approval exactly once, and can resume the chain.
  Added CLI commands `paos approve` and `paos approvals`.
- `demo/contracts/software-change-gated.json` - an R4 contract that exercises
  the gate -> approve -> complete path.
- **Real CLI adapters** `CodexAdapter` and `ClaudeCodeAdapter` (G2 gate). The
  untrusted objective travels over stdin, never argv; dispatch runs without a
  shell using an argv array. No vendor permission-bypass flag is ever passed -
  Claude Code is told to auto-deny prompts so an unattended run can neither
  escalate nor hang. Codex advertises exactly what its `-s <mode>` grants, so
  `read-only` never claims write access. Credentials are not probed implicitly:
  `--auth` opts into the vendor status command, and a timeout is reported
  rather than guessed.
- `packages/adapters/src/process-exec.ts` - output-capped subprocess runner
  with the cmd.exe wrapper Windows npm shims require (`.cmd` cannot be spawned
  by Node directly) and a carefully escaped `quoteCmdArg`.
- `paos adapter doctor [id] [--auth]` diagnoses every known adapter, including
  the real CLI ones, with provider-correct login hints.
- `paos evals [--cases F] [--json]` runs the deterministic gate suite, sharing
  `runGateSuite()` with `pnpm evals:deterministic` so the two entry points
  cannot report different verdicts.
- Two additional deterministic gates: `case-integrity` (empty/duplicate case
  ids, blank descriptions) and `matrix-coverage` (every one of the 12 scenarios
  needs at least one case, otherwise the suite passes vacuously). A malformed
  JSONL line is scored as a case-integrity failure instead of aborting, so one
  bad line cannot hide the verdict for the rest.

### Changed
- Demo contract objective reworded to a scoped local edit so the documented
  first loop actually completes (deny-first NL classification keeps unknown
  objectives at R4, which correctly parks them on the human gate).
- Vitest collects test files serially (`fileParallelism: false`). Parallel
  collection can silently drop test files under a brokered filesystem, which
  understates measured coverage.
- runContract() split into intake and `runDispatchPhase()` so an approved run
  resumes through the same dispatch path instead of duplicating it.
- CLI flags accept space-separated values (`--contract file`) as well as
  `--key=value`; CLI errors are reported cleanly with exit code 1.

## [0.1.0] - 2026-10-25

### Added
- Kernel packages: `contracts`, `core`, `db`, `runtime`, `policy`, `adapters`, `evidence`, `evaluation`.
- 14-state task machine (T1-T37 transition matrix, 36 legal edges with guards).
- Single risk model R0-R4 with deny-first classification.
- Approval gate (R3 human decision, R4 one-time token + nonce + consume-once).
- Contract v1.1 / Result v1.1 JSON schemas served from `paos://` store.
- Dispatch outbox with `unknown_outcome` and five fault-injection points.
- Worker lease + compare-and-swap with adapter-derived heartbeat.
- Three-layer deterministic verification engine (protocol / product / business).
- Full-tree snapshot escape detection (symlink / traversal / case).
- SQLite 22-table baseline with migration ledger and append-only audit triggers.
- Zero-secret demo adapter and deterministic eval gates (12-scenario matrix).
- `paos` CLI: `init`, `status`, `adapter doctor`, `plugin inspect`.
- Apache-2.0 license, SECURITY.md, CONTRIBUTING.md, ADRs, CI pipeline.

### Known limitations
See `README.md -> Known limitations`. Notable: no OS-level sandbox in v0.1,
real CLI adapters (codex / claude-code) are PoC-stage pending on-machine probe.

[Unreleased]: https://github.com/drake-yuan/personal-agent-os/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/drake-yuan/personal-agent-os/releases/tag/v0.1.0
