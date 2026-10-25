# Personal Agent OS

> **Local-first personal OS kernel: turn goals into tasks, delegate tasks to the agents you already have (Codex / Claude Code / Gemini / WorkBuddy…), check results with contracts and three-layer verification, and let weekly review make the next round better.**
>
> **This is not another agent framework. It is the scheduling, governance and memory layer on top of your existing agent fleet.**
>
> **v0.1 positioning: an orchestrator of trusted local user operations — NOT a sandboxed runtime for untrusted agents or plugins.**

[![CI](https://github.com/your-org/personal-agent-os/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/personal-agent-os/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

English | [中文说明](#中文说明)

---

## Why

You already run an agent fleet. What you lack is the operating system around it:

- **Goals decay into nothing.** Tasks live in five tools; nothing enforces a done-condition.
- **Agents claim completion.** "Done!" is not evidence. Nothing independently verifies.
- **Irreversible actions are one prompt away.** Money, deletion, external sends need a human gate.
- **Interrupted runs vanish.** A crashed dispatch becomes a duplicate task, or a silently lost one.

PAOS is a thin kernel that does exactly five things: **goals / tasks / state / evidence / approvals**. Agent capability is attached through adapters; every delegation has a machine-verifiable definition of done.

## What is verifiable today (v0.2 codebase)

| Capability | Where | Verified by |
|---|---|---|
| Task state machine, 14 states / 36 legal edges (T1–T37 matrix) | `packages/core/src/task-machine.ts` | full edge matrix tests: every legal edge passes, every illegal pair rejected |
| Single risk enum R0–R4, deny-first classification | `packages/core/src/risk.ts` | unknown actions default to R4 |
| Approval gate: R3 human decision, R4 human + token + one-time nonce, consume-once, action/scope binding | `packages/core/src/approval.ts` | replay/supersede/expiry tests |
| Contract v1.1 + Result v1.1, `additionalProperties: false`, `paos://` schema whitelist | `schemas/`, `packages/contracts` | schema validation suites incl. negative cases |
| Checker whitelist (9 checkers), no arbitrary shell/JS | `packages/contracts/src/checkers.ts` | fail-closed registry tests |
| Three-layer verification (protocol / product / business) | `packages/runtime/src/verify.ts` | layer + verdict tests |
| Dispatch outbox with `unknown_outcome` (exactly-once is never promised unilaterally) | `packages/runtime/src/outbox.ts` | five fault-injection tests |
| Worker lease + CAS + adapter-derived heartbeat threshold | `packages/runtime/src/lease.ts` | double-worker tests |
| Full-tree snapshot escape detection (symlink / traversal / case) | `packages/runtime/src/snapshot.ts` | escape scenario tests |
| SQLite baseline: 22 tables, migration ledger, append-only audit triggers, ≥3.51.3 runtime gate | `packages/db`, `migrations/0001_init_v2.sql` | migration / trigger / version-gate tests |
| Local API auth model: installation_secret + Bearer + Host/Origin/Sec-Fetch-Site | `packages/policy`, design §12.1 | security test plan (G4) |
| Zero-secret demo adapter + deterministic eval gates (12-scenario matrix) | `packages/adapters`, `packages/evaluation`, `evals/cases.jsonl` | `pnpm evals:deterministic` |

Test status: **137 tests across 23 files, all passing** (`pnpm -r test`), plus `pnpm drift:check` (enum single-source), `pnpm evals:deterministic` (12/12), and strict `tsc` builds.

## Quick start (no API keys needed)

```bash
pnpm install
pnpm build
pnpm -r test            # full deterministic suite

# first-run: creates data/paos.db, installation.secret (0600), applies migrations
node apps/cli/dist/index.js init --data-dir=data

node apps/cli/dist/index.js status --data-dir=data
node apps/cli/dist/index.js adapter doctor          # five-level diagnostics
node apps/cli/dist/index.js plugin inspect demo/manifest.json  # install phase 1: zero code execution
pnpm evals:deterministic                            # deterministic gates
```

The demo adapter executes recorded fixtures, so the first task loop (Inbox → contract → dispatch → three-layer verification → Review) runs entirely offline.

> **Windows + sandboxed shells note:** if your shell sandbox blocks writes to the system temp dir, point `TEMP`/`TMP` inside the workspace before running tests (vitest SSR cache).

## Repository layout

```
apps/cli                 paos CLI (init/status/run/evals/adapter doctor/plugin inspect)
packages/
  contracts              single source of truth: enums, JSON schemas, checker registry, paos:// store
  core                   task state machine (T1-T37), approval gate (R0-R4), risk, fleet registry
  db                     SQLite open + version gate, migration runner, backup API
  runtime                dispatch outbox, worker lease, status map, three-layer verify, snapshot
  policy                 structured action policy, data-transfer gate
  adapters               AgentAdapter interface, registry, doctor, zero-secret demo adapter
  evidence               artifact store (opaque IDs, sha256, size caps)
  evaluation             deterministic gates + 12-scenario matrix
schemas/                 canonical paos:// JSON schemas
migrations/              versioned SQL migrations (0001 = v2.0 baseline, 22 tables)
workflows/               linear workflow definitions (v0.1: five step kinds, no DAG)
skills/                  SKILL.md convention + PAOS extension fields
domains/                 domain packs (declaration-only, no arbitrary code)
demo/                    synthetic fixtures (Alex Chen / Acme / Project Aurora - fictional)
evals/                   deterministic case matrix
openapi.yaml             REST contract (v1)
events.schema.json       SSE event contract
docs/                    design references, ADRs, open-source playbook
```

## Architecture in one paragraph

`core` owns every state transition — it is the only module allowed to change state. `runtime` dispatches through an outbox (`dispatch_intents`) committed **before** any network call, derives status through a single `mapProviderStatus`, and verifies through three deterministic layers. `policy` decides on structured action type + resource scope + data classification + **enforced** (never declared) adapter capabilities. `adapters` can only report observations — there is deliberately no `completeTask` method; task `done` is written by the Verifier only, with `accepted_at` + `evidence_refs` + `verification_report_ref`.

## Known limitations (v0.1 — read before trusting)

1. **No OS-level sandbox.** v0.1 is an orchestrator of trusted local operations. CLI adapters on Windows are `unconfined`; scope-restricted contracts are refused rather than pretended-safe.
2. **No arbitrary third-party plugins.** Only `builtin` / `reviewed` adapters; install runs `inspect → trust → probe → grant` with zero code execution during inspect.
3. **WorkBuddy cloud adapter is PoC-stage** (OAuth review pending); `handoff` mode is the documented fallback.
4. **Evals prove determinism, not intelligence.** Passing cases show the control loop works — they are not evidence that "the agent got smarter".
5. **Single user, local-first, no accounts.** Remote access is a separate security mode (v0.2+), never `0.0.0.0` by default.
6. **SQLite runtime gate is 3.51.3** (WAL-reset fix). Node 22.22 bundles 3.51.2 — override explicitly with `PAOS_MIN_SQLITE_VERSION` if you accept the risk.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: manifest schemas, eval cases, domain-pack templates. Security reports: [SECURITY.md](SECURITY.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). Patent grant explicit; CLA policy will be settled before external contributions are accepted — the rules will not change retroactively.

---

## 中文说明

**Personal Agent OS** 是本地优先的个人操作系统内核：把目标变成任务，把任务委派给你已有的 Agent 舰队（Codex / Claude Code / Gemini / WorkBuddy），用契约与三层验收检查结果，用周复盘让下一次更好。

- **不是另一个 Agent 框架**，而是你已有舰队之上的调度、治理与记忆层。
- **v0.1 定位**：本机可信用户操作的编排器，不是安全沙箱化的不受信 Agent 运行时。
- **三个可验证差异点**：① 目标驱动的任务状态机 + Evidence 门（executor 声称完成不算数）；② Contract v1.1 + 协议/产物/业务三层确定性验收；③ 公共框架 + 私有实例 + 合成 Demo 严格隔离（仓库零个人数据）。
- **已知限制**：无 OS 级沙箱、不支持任意第三方热加载插件、WorkBuddy 云端适配器仍处 PoC、Evals 只证明确定性不证明「变聪明」——详见上文 Known limitations。

快速开始：`pnpm install && pnpm build && pnpm -r test`，然后 `node apps/cli/dist/index.js init --data-dir=data`。无需任何 API key（demo 适配器使用录制 fixture）。
