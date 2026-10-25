# Contributing to Personal Agent OS

Thanks for caring about a local-first, verifiable personal OS kernel. This document defines how to contribute without breaking the properties that make the project worth using.

## Ground Rules

1. **Determinism first.** Anything that gates a merge must be deterministic. Model-quality evals are threshold-based and reported separately  -  never blended with deterministic gates.
2. **The state machine is the spec.** Every legal transition edge has a test; every illegal edge must be rejected. If you change `TRANSITIONS`, the matrix tests must change with it.
3. **Enums have one home.** `packages/contracts/src/enums.ts` generates the TS types, the SQLite CHECK documentation, and the JSON schemas. `pnpm drift:check` must stay green.
4. **No arbitrary execution.** New checkers go through the whitelist registry with an args schema. No shell strings, no `eval`.
5. **Observations, not verdicts.** Adapters report what happened; only Runtime/Verifier derives `accepted` / `rejected` / `needs_human` / `unknown_outcome`.
6. **AI assistants do not auto-commit or auto-push.** A human reviews every diff before it becomes a commit.
7. **English comments, conventional commits**: `feat(scope): ...` / `fix(scope): ...` with a Cause/Impact body.

## Development Setup

```bash
pnpm install
pnpm build
pnpm -r test
pnpm drift:check
pnpm evals:deterministic
```

Node >= 22.5 (uses `node:sqlite`), pnpm >= 9. On sandboxed Windows shells, point `TEMP`/`TMP` into the workspace before running tests.

## PR Checklist

- [ ] `pnpm -r build` and `pnpm -r test` green (currently 137 tests / 23 files)
- [ ] `pnpm drift:check` green
- [ ] New behavior covered by tests; new risk controls covered by an eval case in `evals/cases.jsonl`
- [ ] No secrets, no personal data, no absolute machine paths in fixtures (use the synthetic `demo/` data: Alex Chen / Acme / Project Aurora)
- [ ] Public docs updated if user-visible behavior or limitations changed

## Good First Contributions

- **Manifest schemas**: PluginManifest / SkillManifest edge cases (`packages/contracts`)
- **Eval cases**: extend the 12-scenario matrix (`evals/cases.jsonl`)
- **Domain packs**: declaration-only packs under `domains/` (career/learning/venture templates)
- **Checkers**: new whitelisted checkers with args schema + failure codes
- **Docs**: translations, ADRs, troubleshooting notes

## Decision Records

Architecture decisions live as ADRs in `docs/adr/`. An ADR states: context, options considered, decision, consequences, test anchors. ADRs are public and commentable; a decision that changes a contract or a security property requires a new ADR that supersedes the old one.

## Code of Conduct

Be direct, be kind, assume competence. Criticism targets code and claims, never people. The maintainers reserve the right to close threads that violate this.
