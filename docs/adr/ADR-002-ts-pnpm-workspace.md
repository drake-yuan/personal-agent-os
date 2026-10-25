# ADR-002: TypeScript + pnpm workspace

- **Status:** proposed
- **Date:** 2026-10-25

## Context

The deterministic core (state machine, contracts, checkers) benefits from static
types; the maintainer's background is TS-first; CLI adapters need `spawn` with
argv arrays.

## Options

1. TypeScript + pnpm workspace
2. Plain Node.js ESM
3. Python + uv workspace

## Decision

TypeScript (strict, `noUncheckedIndexedAccess`) + pnpm workspace.

## Consequences

- Positive: schema-driven contracts type-check against generated enums; vitest
  ecosystem; Node 22 `node:sqlite` removes native deps.
- Negative: build step required before running dist entry points; `node:sqlite`
  is experimental (loaded via `createRequire` for toolchain compatibility).

## Test anchors

`pnpm -r build` + `pnpm -r typecheck` + `pnpm -r test` in CI.
