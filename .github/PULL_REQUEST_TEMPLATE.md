<!--
PR title convention: `feat(scope): ...`, `fix(scope): ...`, `docs(scope): ...`
with a Cause/Impact body (see CONTRIBUTING.md).

Scope = package or subsystem, e.g. core, runtime, db, cli, contracts.
-->

## What
<!-- One sentence: what changes and why. -->

## Why
<!-- Root cause or motivation. Link the issue / ADR. -->

## Impact
<!-- What is affected: state behavior, API, migrations, adapters. -->

## Checklist
- [ ] `pnpm -r test` passes (deterministic suite)
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm drift:check` green (enums = DDL = schemas)
- [ ] `pnpm evals:deterministic` 12/12 (if verification logic changed)
- [ ] New behavior has a test
- [ ] Comments and docs are English, ASCII-clean
- [ ] No secrets, no real asset paths, no personal data committed
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (if user-facing)
