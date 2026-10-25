# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/your-org/personal-agent-os/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/personal-agent-os/releases/tag/v0.1.0
