# ADR-001: Modular monolith

- **Status:** proposed
- **Date:** 2026-10-25

## Context

A single maintainer operates the kernel. Package boundaries must express domain
boundaries without paying distributed-system costs.

## Options

1. Microservices (separate deployables per domain)
2. Modular monolith with enforced dependency rules
3. Single flat package

## Decision

Modular monolith. CI enforces `core <- runtime <- adapters`; `contracts` is depended
on by everything and depends on nothing; `domains/*` may only depend on
core/runtime/contracts.

## Consequences

- Positive: one process, one DB, debuggable; package boundaries still prevent
  accidental coupling.
- Negative: discipline depends on CI dependency rules; no independent scaling.

## Test anchors

Dependency-rule CI check (planned); import-graph test per package.
