# Web Cockpit v0.2 — Technical Selection Review

- **Date:** 2026-10-30
- **Reviewer:** implementation-side review (pre-decision)
- **Scope:** the three stack options proposed for the Web Cockpit (v0.2)
- **Verdict:** the originally proposed default (**Option A — zero-dependency `node:http` + Vanilla TS**) is **rejected as the v0.2 production shape**. Two corrections dominate: (1) the framing treated the cockpit as a *visualisation* when it is a **safety-relevant control surface**, and (2) it under-weighted a far cheaper sequencing (static snapshot first). A fourth option (**Option D — Hono + Vanilla TS**) is added and recommended.

This review is written against the repository as it stands on 2026-10-30 (`main` = `676fa90`). Every claim below cites the file, line, or measured command that produced it. Claims without evidence are labelled as judgement.

---

## 0. The options as posed

| | Service layer | View layer | New runtime deps |
|---|---|---|---|
| **A** | Node built-in `node:http` | Vanilla TS + Vite | 0 |
| **B** | Hono | React + Vite | react, react-dom, hono, @hono/node-server |
| **C** | Node built-in `node:http` | React + Vite | react, react-dom |

---

## 1. Facts established before reviewing

These were measured, not assumed. Several of them invalidate premises in the original framing.

| # | Fact | Evidence |
|---|---|---|
| F1 | There is **no HTTP layer at all** in the repo — the CLI is the only entry point. | `grep -rE "createServer\|express\|fastify\|hono\|koa\|listen\("` over `packages/` + `apps/` → 0 hits |
| F2 | There is **no frontend at all** — not even a static HTML file. | `find -name "*.html"` → 0 hits; no react/vue/svelte in `package.json` or `pnpm-lock.yaml` |
| F3 | `vite@6.4.5` is a root **devDependency** (introduced for vitest 4), not an application bundler. | `package.json` devDependencies; commit `4a10a00` |
| F4 | `openDatabase()` **always opens read-write** and forces `PRAGMA journal_mode = WAL`. There is no read-only path. | `packages/db/src/db.ts` (`openDatabase`) |
| F5 | `node:sqlite` **does** support `{ readOnly: true }` on the local runtime. | measured on local Node **v22.22.2**: `new DatabaseSync(p,{readOnly:true})` → row read OK |
| F6 | The declared Node floor is **below** the version that introduced that option. | `package.json` → `engines.node: ">=22.5.0"` (local runtime is v22.22.2) |
| F7 | `DatabaseSync` is **synchronous**. A dispatch executed in-process blocks the event loop — and therefore the whole HTTP server. | `node:sqlite` API is sync by design; `packages/runtime/src/pipeline.ts` drives it synchronously |
| F8 | `cmdStatus` returns a **plain formatted string**, not JSON. | `apps/cli/src/index.ts:126-138` |
| F9 | `cmdApprovals` returns a **plain formatted string**, not JSON. | `apps/cli/src/index.ts:534-547` |
| F10 | The `--json` flag is **already plumbed** into the CLI argument parser. | `apps/cli/src/index.ts:307` (`args.flags['json']`) |
| F11 | **Approving requires the contract file** — approval is not a bare DB write. | `apps/cli/src/index.ts:562` (`cmdApprove` requires `--contract <file>`) |
| F12 | An **existing secret mechanism** already exists and is used for backups. | `apps/cli/src/index.ts:116-117` — `installation.secret` written with mode `0600`; copied in `createBackup` (`:163-168`) |
| F13 | CI runs on **ubuntu-24.04** with **Node 22**; development happens on Windows. | `.github/workflows/ci.yml` |
| F14 | `pnpm audit --audit-level high` and **gitleaks are hard CI gates**. | `.github/workflows/ci.yml` (audit + secret scan steps, no `continue-on-error`) |
| F15 | A new workspace package is **auto-included** in build/test/typecheck. | `pnpm-workspace.yaml` → `apps/*`, `packages/*`; CI runs `pnpm -r build/test/typecheck` |
| F16 | The task model is a **14-state machine with 37 legal edges**; `done` is written only by the Verifier. | `packages/core/src/task-machine.ts:47-85`; `packages/core/src/types.ts` |
| F17 | The repo keeps **ADR-style decision records**, `proposed` until ratified in the personal decision log. | `docs/adr/README.md`; 3 existing ADRs |
| F18 | ADR-001 states the constraint explicitly: **a single maintainer operates the kernel**. | `docs/adr/ADR-001-modular-monolith.md` |
| F19 | **No live database exists** on the dev machine, so the cockpit has no data to render yet. | `data/paos.db` absent (`ls` exit 2) |
| F20 | A reusable **demo fixture** does exist. | `demo/fixtures/demo-run.json` (referenced at `apps/cli/src/index.ts:316`) |

---

## 2. Option-by-option assessment

### 2.1 Option A — zero-dependency (`node:http`) + Vanilla TS

**What is genuinely right about it.** The instinct is sound on the domain side. This repository has repeatedly chosen zero-dependency implementations where a dependency added nothing (`loadLocalEnv()` in `de24739`, the hand-written `drift-check.js`); ADR-001/002/003 make "minimal, auditable, single maintainer" a deliberate architectural stance, not an accident. `vite` is already in the tree (F3), so "Vanilla TS + Vite" adds no runtime dependency. `node:http` and `node:sqlite` are the same platform generation and compose without glue. For a **read-only, local, single-user** view, this option is genuinely the lowest-complexity answer and would probably have been the right call for v0.1.

**Where it breaks.** The zero-dependency argument is being applied to the wrong layer, and the failure mode is asymmetric:

1. **The delivery layer is where the risk lives, not the domain layer.** `node:http` is a protocol primitive, not a server framework. It supplies no router, no body parsing, no static file serving, no body-size limit, no request logging, no graceful shutdown. Every one of those must be hand-written *correctly*, and the ones that are easy to get wrong are the security-relevant ones.
2. **Hand-written static file serving is a path-traversal honeypot, and this dev box is the worst case.** Windows path semantics are materially harder than POSIX: drive-relative paths, UNC (`\\?\`), 8.3 short names, reserved device names (`CON`, `PRN`, `NUL`), and alternate data streams. A traversal bug written on Linux is caught by CI; a traversal bug in Windows path handling is **only** reproducible on the Windows dev box (F13), so the CI gate cannot see it.
3. **`node:http` performs no `Host`-header validation**, which is the precondition for **DNS rebinding** — a malicious web page can reach `http://127.0.0.1:<port>` through the victim's own browser. Combined with an approval endpoint (§3.1), this is a path from "a web page you visited" to "an approval you did not personally make".
4. **No default request-body cap.** A local process can POST an arbitrarily large body and exhaust memory.
5. **The "fewer dependencies = safer" premise inverts here.** F14 shows the project treats supply chain as a hard gate. But the benefit of one fewer dependency is realised in the *domain* layer, where the code is small and unit-testable; the cost is realised in the *transport* layer, where the code is large, adversarial-facing, and hardest to test. Trading a low risk for a high one is the wrong direction, and the trade is invisible unless it is stated explicitly.

**Maturity.** `node:http` itself is extremely mature (decades). The risk is not the API surface — it is that "mature primitive" gets read as "mature server". It is not.

**Applicability boundary.** Option A is defensible **only** for a strictly read-only surface with no static file serving from disk (i.e. HTML embedded in the binary, or served from a single file with a hard-coded name and no user-controlled path segment). As soon as the cockpit can be asked to approve anything, its risk profile changes while its benefit does not.

**Verdict:** reject for v0.2 as a write-capable service; retain as a candidate for the read-only v0.1 (§4.1).

### 2.2 Option B — Hono + React + Vite

**What is genuinely right about it.** Hono is a single-file, dependency-free, ~14 KB framework that runs directly on `node:http` — the same stack as `node:sqlite` and `node:http`, so it introduces no adapter layer between the server and the platform. It provides parameterised routing, body parsing, structured error handling, first-class SSE, and middleware (auth, logging, rate-limit) — exactly the set that Option A forces you to hand-roll. React is the mature default for interactive dashboards, and F18's "single maintainer" constraint means ecosystem maturity matters more than novelty.

**Where it breaks.** The two halves have different cost/benefit profiles and were bundled here:

1. **React's cost is real and front-loaded.** Two runtime dependencies, a build step, and a client runtime whose value is proportional to UI complexity. For a cockpit that renders server-fetched JSON into a handful of views, the virtual DOM earns little — and this is a *local* app, so there is no SEO benefit and no first-paint optimisation pressure at all.
2. **Hono's benefit is real but should be sized.** If v0.2 ends up with ~8 endpoints, Hono saves perhaps 150 lines of routing boilerplate. Against that: a new runtime dependency must clear the `pnpm audit --audit-level high` hard gate (F14), and `hono` + `@hono/node-server` are *two* packages to track. That is a fair trade — but the honest reason is **risk reduction in the transport layer**, not line-count savings. The original framing sold the wrong benefit.
3. **Hono's static-file serving has a runtime-specific detail worth verifying at implementation time rather than assuming**: `hono/serve-static` targets the Bun/Deno runtimes, while Node deployments use `@hono/node-server/serve-static`. Confirm the exact pairing and path-traversal guarantees for the version actually installed rather than trusting the docs headline.
4. **Maturity differential.** Hono is comparatively young (2022→), API-stable but still evolving; React is decades-mature. In a repo whose ADRs are still `proposed`, adding a young framework is a modest but real increase in the surface that must be maintained by one person.

**Applicability boundary.** Option B fits if the cockpit is intended to become a **real application** — contract editing, multiple screens, live streaming, form validation — because React's cost is amortised there.

**Verdict:** the service layer is right; the view layer is premature. Split it (§2.4).

### 2.3 Option C — `node:http` + React + Vite

This is the only option whose **structure** is correct: it decouples "which HTTP library" (decided by endpoint count and protocol needs) from "which view framework" (decided by UI complexity and interaction density). That separation is the correct decision axis, and the original framing did not acknowledge it.

Its service layer inherits every defect in §2.1; its view layer inherits the premature-React objection in §2.2. As a whole it is strictly dominated by Option D below.

**Verdict:** reject; keep its decoupling principle.

### 2.4 Option D (added by this review) — Hono + Vanilla TS

- **Service layer:** Hono on `@hono/node-server`. Kills the entire §2.1 defect list (routing, body parsing, body-size limits, `Host` validation, static file serving) without abandoning the zero-`node:http` philosophy. Keeps the domain layer at zero new dependencies, which is where "minimal supply chain" actually pays.
- **View layer:** Vanilla TypeScript + Vite, with the API client isolated in a typed `@paos/api` package. For v0.2's surface — a status board, an approval queue, a detail drawer — this is sufficient and adds zero runtime dependency to the shipped product.
- **Cost:** one new runtime dependency tree (hono + @hono/node-server + their transitives) versus Option A's zero.

**Verdict: recommended for v0.2**, conditional on the P0 items in §5 (read-only DB access, auth, loopback-only binding).

---

## 3. Over-design, omissions, debt

### 3.1 Over-design in the original proposal

| # | Item | Why it is wrong |
|---|---|---|
| OD1 | **"Contract editing visualisation" inside v0.2** | The contract's source of truth is `@paos/contracts` (enums + schema). This repo has *already paid* for a hand-copied-drift bug: `ddl-doc.json` and `contract.json` are hand-copied artefacts and only `drift-check.js` catches the divergence. A browser-side contract editor creates a **second authoring path** whose divergence from the schema is invisible to `drift-check` (a Node-side script) — the exact failure mode already experienced once. Contract authoring belongs at the schema's side (CLI / editor with server-side validation); the cockpit should **display** contracts and link to their source, not author them. **Remove from v0.2.** |
| OD2 | **"Call runtime functions in-process when an action is needed"** | Vague, and the most dangerous clause in the proposal. `runContract` is a synchronous, SQLite-backed, dispatch-driving flow (F7). Executed inside the HTTP process, it blocks the event loop: the server cannot answer *any* request for the entire duration of a dispatch — which is exactly the window in which the user wants to watch the task move through the 14 states (F16). The cockpit would hang precisely when it matters most. |
| OD3 | **"Approval" as a generic browser button** | `cmdApprove` requires `--contract <file>` (F11) because approving a task resumes the chain. A browser holds no contract file. Either the server must locate the contract from the run's `input_ref` (a path-resolution + traversal-safety problem), or the browser can only *record a decision* without resuming the chain — which is a **semantic change** that must be stated, not glossed. The original proposal never confronted this. |
| OD4 | **Three options presented as one symmetric choice** | The three options differed in service layer *and* view layer *and* feature scope at once. Any real disagreement was therefore unresolvable — the user was being asked to ratify a bundle rather than pick a shape. Separating them is what made this review possible. |

### 3.2 Omissions

| # | Missing | Consequence if unaddressed |
|---|---|---|
| OM1 | **Authentication / local attack surface** | No auth existed to weaken (F1) — the omission is the *introduction* of a new one. The cockpit can (a) approve actions, which the design treats as an R4 human-confirmation token, and (b) trigger dispatches that execute **real agent CLIs on the user's machine** (`codex`, `claude`, `gemini`, `qwen` — all verified present). That is a local privilege-escalation surface. Mitigation must reuse the existing `installation.secret` mechanism (F12), not invent a new one. |
| OM2 | **Read-only DB access path** | `openDatabase()` is read-write (F4). A UI that opens the DB read-write can contend with the CLI's write lock and can mutate state outside the task machine. `node:sqlite` supports `{readOnly:true}` on the local runtime (F5), but the declared floor (F6) is below the version that introduced it → raise the floor or feature-detect. |
| OM3 | **A DTO / read-model layer** | If the API returns DB rows directly, the DB schema *becomes* the external contract; every migration is then a breaking UI change, and columns like `evidence_refs` (a JSON string holding an array) leak into the front end. The repo's own drift experience (OD1) says this must be explicit and machine-checked. |
| OM4 | **Live-update mechanism** | The value of a 14-state cockpit is watching transitions. Poll (≈1 s) versus SSE was never decided. |
| OM5 | **CI and workspace integration** | F15 means a new package is picked up automatically by `pnpm -r build/test/typecheck` — but it also means the **front-end build output becomes part of the CI build**, and "who serves the static assets in production mode" (dev: vite dev server + proxy; prod: built `dist/`) must be decided or the result will work locally and fail to build in CI. |
| OM6 | **Seed / fixture data** | F19: no live DB exists → nothing to render. F20: `demo/fixtures/demo-run.json` is the natural seed source. |
| OM7 | **Windows ⇄ Linux path parity** | F13 plus the already-fixed POSIX-path defect (`a0859fa`, `b098fcf` → `packages/core/src/path.ts`) mean any path the server resolves must go through `normalizeHostPath`, and the server must be exercised on Windows locally, not only on ubuntu in CI. |
| OM8 | **Explicit non-goals** | The proposal never listed what v0.2 will *not* do. For a project whose recorded failure mode is scope drift (16 business directions in the personal OS; 7 frozen), an explicit non-goal list is a control, not a nicety. |

### 3.3 Technical debt created by each option

| Option | Debt introduced | Migration cost later |
|---|---|---|
| A | Hand-rolled router + static serving + body parsing + auth plumbing | Moderate — the transport surface is small and concentrated, so replacing it later is a contained rewrite of one package |
| B | React + Hono + a second build pipeline | Low for React if it is used properly; the React→Vanilla direction is the expensive one and is essentially never worth taking |
| C | React + hand-rolled transport | Moderate, same as A plus a framework migration if the view layer is later judged insufficient |

**Note on the irreversible direction.** The expensive migration is *Vanilla → React*, not *React → Vanilla*. A vanilla codebase that later grows shared cross-screen state is expensive to convert to React; a React codebase is never painful to keep in React. This asymmetry argues for making the **view-layer** choice in the direction that is cheap to change *only if the framework is already abstracted* — which is why OM3 (a framework-agnostic typed API client) matters more than the framework choice itself.

---

## 4. Alternatives and switch thresholds

### 4.1 Alternative 0 — v0.1: CLI `--json` + single-file static HTML (no server)

**This is the sequencing this review believes is strongest, and it was under-weighted in the original proposal.**

- **Cost:** `cmdStatus`/`cmdApprovals` return plain strings (F8, F9) and the `--json` flag is already plumbed (F10) → JSON output is a small, low-risk change. A single-file HTML board (fetching a `state.json`) is roughly a day of work. No HTTP server, no auth, no new dependency, no new attack surface.
- **Coverage:** the task-machine board and the approval queue — the two stated v0.2 goals — are covered **completely**. What is *not* covered: live refresh, and browser-initiated approval.
- **Constraint to respect:** under `file://`, `fetch()` of a local JSON file is blocked by CORS unless the page is opened with a permissive flag; the robust form is `paos export board --out board.html` — the server writes a **fully self-contained HTML file** with the data inlined. This matches an existing pattern in the personal workspace (static HTML dashboards such as `radar-report.html`, `board.html`).
- **Value of the exercise:** it validates the premise cheaply. If nobody looks at the board, the HTTP service was never going to be worth it. If people do look at it, the *exact* fields, groupings, and density they want become known — which is precisely the input the React-vs-Vanilla decision needs, and it removes the guesswork from OD1.

**Switch threshold (v0.1 → v0.2):** move to a server when *any* of these becomes true — (a) the board must update without regenerating a file; (b) approval must be actionable from the browser; (c) more than one machine needs to read the board simultaneously.

### 4.2 Alternative 1 — Option D (Hono + Vanilla TS) — recommended for v0.2

**Switch threshold from the zero-dependency position:** adopt a server framework when *any* of — endpoint count exceeds ~8; static assets must be served from disk with correct MIME/caching; SSE is required; or a shared middleware stack (auth, request logging, rate limiting) is needed. Given that the cockpit has an auth requirement from day one (OM1), **the threshold is already crossed at v0.2**; the framework should be chosen up front rather than retrofitted.

### 4.3 Alternative 2 — React

**Switch thresholds (measurable — adopt React when any one holds):**
- (a) more than three screens carrying shared state;
- (b) form-level live validation (i.e. contract editing — but see OD1: that is deliberately deferred, so (b) cannot trigger until OD1 is reversed);
- (c) optimistic updates after an approval (approve → instant UI change);
- (d) streaming updates faster than ~1 Hz;
- (e) more than one person maintains the front end.

**Today none of (a)–(e) holds.** The v0.2 surface is a board, a queue, and a detail view — so Vanilla TS is correct, and §4.1's low-cost spike will surface whether (a) is approaching.

### 4.4 Alternative 3 — remote / multi-device access

The personal workspace is explicitly cross-machine, so the demand for "look at the cockpit from my phone" is real. But: approving an R4 action is a **safety-critical human confirmation** in this design. Once the port leaves loopback, every local-only assumption fails at once.

**Switch threshold:** remote binding may be enabled only after all of — authentication is enforced on every endpoint (not just mutations); read-only is the default and mutations require re-authentication; the listener is bound to a private network interface (Tailscale/WireGuard), never to a public one; every mutation is written to the audit trail. Until then, **bind to 127.0.0.1 and document it**.

### 4.5 Comparison summary

| | Server | Auth surface | New runtime deps | Real-time | Approve from browser | Effort | Reversibility |
|---|---|---|---|---|---|---|---|
| Alt. 0 (v0.1) | none | none | 0 | no (regenerate) | no | **~1 day** | total (delete a file) |
| A | `node:http` | hand-rolled | 0 | manual | hard (F11/OD3) | ~1 week | moderate |
| B | Hono | middleware | 3–4 | yes | hard (F11/OD3) | ~2 weeks | low |
| C | `node:http` | hand-rolled | 2 | yes | hard (F11/OD3) | ~2 weeks | moderate |
| **D** | **Hono** | **middleware** | **1–2** | **yes** | **hard (F11/OD3)** | **~1.5 weeks** | **low** |

---

## 5. Recommendations, prioritised

### P0 — before the first line of API code

| # | Action | Rationale | Anchor |
|---|---|---|---|
| P0-1 | **Write `ADR-004`** recording: the cockpit is read-mostly; contract *editing* is out of scope; loopback-only; the approval semantics boundary. | Prevents scope drift while building; the repo's own failure mode is scope creep, not technical difficulty. | F17, OD1, OM8 |
| P0-2 | **Ship Alternative 0 first** — add `--json` to `cmdStatus`/`cmdApprovals` and a self-contained `paos export board` HTML. | ~10 % of the cost, ~80 % of the value, and it removes the guesswork from the framework decision. | §4.1 |
| P0-3 | **Authenticate from day one, reusing `installation.secret`.** Bind 127.0.0.1 only; per-boot token in a gitignored file; validate `Host` (DNS-rebinding defence); reject cross-origin `Origin`; cap request bodies; rate-limit. | The cockpit can approve actions and execute real agent CLIs locally. That is a privilege-escalation surface, and `Host` validation is exactly what the hand-written option would have omitted. | OM1, F12, §2.1 |
| P0-4 | **Add a read-only DB path** — `openDatabase(path, { readOnly: true })` — and either raise `engines.node` to the verified introduction version of that option or feature-detect and fall back. | Keeps the UI from taking the write lock or mutating state outside the task machine. | F4, F5, F6 |
| P0-5 | **Create `@paos/api` as the DTO boundary** — typed view models, no DB rows leaking — and extend `drift-check` to cover DTOs against the schema. | Prevents a second hand-copied-drift incident; keeps migrations from breaking the UI. | OM3, OD1 |

### P1 — the v0.2 build

| # | Action | Rationale |
|---|---|---|
| P1-1 | **Adopt Option D**: Hono service layer + Vanilla TS view layer + Vite. | §2.4; eliminates §2.1's security defects without bloating the domain layer. |
| P1-2 | **Execute mutations by spawning the existing CLI** (`paos run`, `paos approve`) as a child process, rather than importing `runContract` into the server. | Keeps the whole tested chain authoritative, keeps the server read-only, and sidesteps F7 (synchronous SQLite blocking the event loop). |
| P1-3 | **Resolve the approval semantics explicitly.** Trace run → `input_ref` → contract file. If the contract is locatable, let the server pass it; if not, the browser records the decision only and the UI states plainly that chain resumption requires the CLI. | F11 / OD3 — this is a semantics decision, not an implementation detail. |
| P1-4 | **Polling first (≈1 s), SSE later.** | A SQLite status query is cheap; SSE adds connection lifecycle before the value is proven. |
| P1-5 | **Contract tests for the API** using vitest + a real `listen(0)` + `fetch` — no extra test dependency — plus a build assertion for the front end. | Keeps F14's hard-gate culture; catches routing/auth regressions without an HTTP client library. |
| P1-6 | **Seed the board from `demo/fixtures/demo-run.json`** so 14-state coverage is visible during development. | F19, F20. |

### P2 — polish, explicitly optional

| # | Action | Rationale |
|---|---|---|
| P2-1 | Dev = vite dev server + proxy to the API; prod = built `dist/` served by the service. | F15: the build must work in CI, not only locally. |
| P2-2 | Route every server-side path resolution through `normalizeHostPath`. | F7-adjacent, `packages/core/src/path.ts`; prevents the POSIX/Windows class of bug already fixed once. |
| P2-3 | README section for the cockpit; `ADR-004` linked from `docs/adr/README.md`. | F17. |
| P2-4 | **Record the non-goals**: contract editing, remote binding, multi-user, mobile layout, React. | OM8. |

### Explicitly not recommended

- **Do not build the contract editor in v0.2** (OD1) — it forks the schema's source of truth.
- **Do not put `runContract` in the HTTP process** (OD2) — it blocks the event loop during exactly the window the cockpit exists to show.
- **Do not expose non-loopback in v0.2** (§4.4).
- **Do not adopt React yet** (§4.3) — the thresholds are measurable and none is met.

---

## 6. Verdict

1. **The original default (Option A) should not be the v0.2 production shape.** Its one genuine strength — zero new dependencies — applies to the domain layer, not to the adversarial-facing transport layer, and it reaches a point where the risk is highest (browser-initiated approval and dispatch) while its benefit stays constant.
2. **The cockpit is a safety-relevant control surface, not a dashboard.** It approves R4 actions and launches real agent CLIs. Authentication, loopback binding, and `Host` validation are P0 requirements, not hardening.
3. **The sequencing was wrong.** Alternative 0 (§4.1) buys most of the value at ~10 % of the cost and, importantly, supplies the missing information for the framework decision. Building the HTTP service first optimises a choice that has not yet been informed.
4. **Recommended shape:** Alternative 0 now → Option D (Hono + Vanilla TS) once the board is proven to be worth live-updating → React only when the §4.3 thresholds are measurable and met.
5. **The heaviest single unresolved item is not technical.** It is OD3/§4.4: the approval button's semantics depend on where the contract file comes from, and remote access requires a separate security decision. Both should be settled in writing (P0-1) before implementation, not during it.
