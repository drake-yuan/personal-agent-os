# Architecture Decision Records

ADRs follow the five-element rule (design V2.0, Section 4): **Decision / Alternatives / Rationale / Consequences / Tests**.
All ADRs start as `proposed`; they become `accepted` only when ratified in the private decision log of the parent OS.

| # | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-modular-monolith.md) | Modular monolith over microservices | proposed |
| [ADR-002](ADR-002-ts-pnpm-workspace.md) | TypeScript + pnpm workspace | proposed |
| [ADR-003](ADR-003-sqlite-single-source.md) | SQLite (WAL) as the only structured source of truth | proposed |

Template for new ADRs: [template.md](template.md).
