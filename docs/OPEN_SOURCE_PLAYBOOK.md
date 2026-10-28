# Personal Agent OS - Open Source Release Playbook

> **The question this document answers:** how this project actually goes open source, rather than "push the code to GitHub and hope".
> Upstream basis: *Personal Agent OS Detailed Design Document V2.0*, Section 19 (open source release strategy), Section 20 (G0-G4 gates), Section 18.3 (data isolation).

---

## 0. One-sentence conclusion

**Pass the gates first, publish second.** Open-sourcing is not the moment `code/` is pushed to GitHub; it is the state where "a stranger can complete the first task loop in 30 minutes, with no keys and no guided tour, and no personal data leaves the database while they do it". Walk the five release gates (G0-G4) from the design document one by one; if any gate fails, stop and fix the gate.

---

## 1. Pre-release hard gates (design Section 20, all MUST)

| Gate | Content | Status (2026-10-25) |
|---|---|---|
| **G0** | No dual definitions of core state/risk/contract; every invariant has a test; empty-DB bootstrap + v1 fixture migration + safe re-run + rollback on failure | PASSED: single-source enums + drift check; 22-table baseline + migration ledger + idempotent replay + checksum rejection; 207 tests |
| **G1** | Zero-secret demo end-to-end; recovers from forced kill + network cut; tasks never auto-complete on an agent's claim; unauthorized API/path tests pass | PASSED: DemoAdapter fixture loop; five outbox fault injections; `done` writable only by the Verifier; snapshot escape detection |
| **G2** | One local CLI adapter's probe/plan/dispatch/stream/cancel/reconcile/mapResult with parameters verified on the actual machine | PARTIAL: interface, demo and real CLI adapters (codex/claude-code) landed and selectable via `paos run --adapter`, verified against real workspace evidence; **a real agent dispatch on the actual machine is still unrecorded** (see `paos adapter doctor`) |
| **G3** | WorkBuddy PoC: OAuth review, real link, credential containment, outbound preview, no duplicate creation on timeout | NOT PASSED (depends on app review, which is a G0 hard gate; `handoff` is the fallback) |
| **G4** | README first screen shows permission model / platform / adapter status / limitations; security checklist; 3-5 unaccompanied trial users; release artifact can be backed up / restored / upgraded / diagnosed | PARTIAL: README first screen + SECURITY.md checklist in place; release operations implemented (`paos backup` / `restore` / `migrate` / `status` / `adapter doctor`); **3-5 unaccompanied trial users still pending** |

**Stop-loss condition (design Section 20):** if G1 fails - the author or a trial user is unwilling to use it daily - pause everything and fix the operational layer first.

---

## 2. Repository governance configuration (done)

| File | Purpose |
|---|---|
| `LICENSE` | Apache-2.0 (ADR D12: explicit patent grant) |
| `README.md` | First-screen positioning statement + permission model + supported platforms + actual adapter status + known limitations + unsupported capabilities (review Section 9, stage 4) |
| `SECURITY.md` | Vulnerability reporting process + honest boundary (v0.1 is not a sandbox) + threat/mitigation table |
| `CONTRIBUTING.md` | Seven ground rules + PR checklist + good first issues |
| `.github/workflows/ci.yml` | `build -> test -> typecheck -> drift:check -> evals:deterministic -> sqlite version assertion -> gitleaks secret scan -> pnpm audit` |
| `.gitignore` | `data/`, `dist/`, `.env*`, `*.pem/key`, `installation.secret` fully ignored (design Section 18.3: the public repo contains zero personal data) |
| `demo/` | Synthetic data only (Alex Chen / Acme / Project Aurora) |

---

## 3. Data isolation, three latches (design Section 18.3, walk before publishing)

1. **gitignore latch:** `me/`, `data/`, and any real asset paths never enter version control.
2. **Secret-scan latch:** CI runs gitleaks on every PR; run it once locally before committing too.
3. **Synthetic-data latch:** `demo/`, fixtures, and eval cases may only contain fictional entities; eyeball `git diff --cached` before every commit.

---

## 4. Cold start and first-release UX (design Section 19.3)

The first experience walks exactly **one** loop: `npx paos init` four-question setup -> `paos demo` (zero-key fixtures) -> `paos adapter doctor` -> first real task with full UI guidance. Every other view ships as empty state + navigation; do not launch seven complex pages at once.

**Trial discipline:** find 3-5 users who did not participate in development; record blockers and completion time. The improvement signal is "the first task a user completes independently", not page count or star count.

---

## 5. License and contributor governance (design Section 19.2)

- Apache-2.0; **settle the CLA policy before accepting external contributions, never change the rules retroactively** (the README currently states this honestly: "CLA pending, rules will not change retroactively").
- Contribution entry points: `good first issue` (manifest / eval case / domain pack templates); Discussions first; ADRs are public and commentable.

---

## 6. Honesty discipline (design Section 19.4, same wording as README)

Content that must stay labeled:

- Adapter parameters are a 2026-10 documentation snapshot; the `[unverified]` label may only be removed after on-machine testing against installed versions;
- WorkBuddy OAuth requires review and is untested before G3;
- Eval metrics do not prove "the agent got smarter";
- The project has not been validated at community scale;
- v0.1 has no OS-level sandbox.

**Writing the limitations down clearly is part of the trust strategy, not modesty.**

---

## 7. Release roadmap (suggested cadence)

| Week | Action | Exit criteria |
|---|---|---|
| W+1 | On-machine probe verification for real CLI adapters (codex/claude-code local parameters) -> close G2 | Seven scenarios (success / non-zero exit / timeout / cancel / wrong output format / permission denied / scope violation) have reproducible tests |
| W+2 | Ratify ADRs one by one (28 `proposed` items from design Section 4 -> `accepted`) | Corresponding votes recorded in the private decision log |
| W+3 | Land the security test suite (injection / escape / credential scan / CSRF / supply chain / malicious manifest) | G4 checklist fully green |
| W+4 | 3-5 unaccompanied trial users + fix blockers | Trial users run the demo independently |
| W+5 | Tag v0.1.0 and publish; sync the workbuddy-mcp roadmap | Release artifact can be backed up, restored, upgraded, diagnosed |

---

## 8. Repository location and naming

- Public repository name: `personal-agent-os` (design Section 18.1)
- Current engineering root: `D:\Personal Agent OS\code\` (git initialized; personal docs/assets stay outside the repo - zero personal data committed)
- Optional future public sub-repos (not blocking the main line): `paos-schemas` (paos:// schema repository), `paos-domain-packs` (domain pack templates)
