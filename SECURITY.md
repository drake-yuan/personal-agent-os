# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.2.x (current development line) | ✅ |
| < 0.2 | ❌ |

## Scope and Honest Boundaries

PAOS v0.1 is an **orchestrator of trusted local user operations**. It is **not** a sandboxed runtime for untrusted agents or plugins, and it does not claim to be. Specifically:

- There is **no OS-level sandbox** in v0.1. CLI adapters on Windows are marked `unconfined`; contracts requiring isolation are refused, not pretended-safe.
- The local API binds `127.0.0.1` / `::1` only and requires `Authorization: Bearer <installation_secret>` plus Host/Origin/Sec-Fetch-Site validation. **Loopback is not treated as authentication.**
- Audit logs are append-only at the application layer (SQLite triggers + append API + hash-chained export). **A local OS administrator can still modify the database file directly** — the tamper-evidence promise covers the application layer and detection capability only.
- Remote access is a separate security mode (v0.2+). Do not expose the API by binding `0.0.0.0`.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

1. Email the maintainers (see repository contacts) with:
   - affected component (package + file),
   - reproduction steps (fixture-based preferred),
   - impact assessment (what an attacker gains),
   - whether the issue involves prompt injection, path escape, approval replay, duplicate dispatch, token leakage, or supply chain.
2. You will receive acknowledgement within **72 hours**.
3. We follow coordinated disclosure: a fix window is agreed with the reporter before any public advisory.

## Security Design References

| Threat | Mitigation | Design section |
|---|---|---|
| Prompt injection via external content | all external input `external_untrusted`; tool whitelist; high-risk human review | §12.5 |
| Path escape by an agent | enforced capabilities + full-tree snapshot detection + symlink resolution | §8.5, §12.2 |
| SSRF via schema/URL fetch | `paos://` whitelist only; no remote schema download | §12.4 |
| Token leakage (logs/diagnostics) | OS keychain or 0600 file; redaction filters; diagnostic package scanning | §12.1, §12.4 |
| Approval replay / misuse | one-time nonce + `action_hash` + `resource_scope_hash` binding + `superseded` on change + consume-once | §12.1 |
| Duplicate dispatch after crash | outbox committed before network call + `unknown_outcome` + measured server idempotency | §11.2 |
| API cross-origin abuse | Bearer + Host/Origin/Sec-Fetch-Site checks; no broad CORS | §12.1 |
| Malicious plugin manifest | four-phase install (`inspect→trust→probe→grant`), zero code execution during inspect; no hot-loading in v0.1 | §9.2 |

## Hard Rules for Contributors

- Secrets never enter the repository. CI runs secret scanning on every PR.
- `sensitive` / `secret` data classifications must never leave the machine without an explicit, recorded approval.
- New acceptance checkers must be registered in the whitelist with a schema and tests — arbitrary shell/JS execution is a security boundary, not a convenience.
- Any change to enums, DDL, or schemas must keep `pnpm drift:check` green (single source of truth).
