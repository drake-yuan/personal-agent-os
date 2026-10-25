---
name: weekly-review
description: Sunday 60-minute weekly review bearing rhythm. Use when the user asks for a weekly review, week close, or Inbox zero session.
allowed-tools: [Read, Write]
acceptance:
  - checker: artifact.exists
    args: { artifact_ids: ["review-notes"] }
  - checker: text.contains_all
    args: { artifact: "review-notes", needles: ["rejections", "next-week"] }
permissions:
  filesystem: workspace-only
  network: none
evals:
  cases: evals/cases.jsonl
input_schema: paos://schemas/weekly-review-input/1.0.0
output_schema: paos://schemas/weekly-review-output/1.0.0
---

# Weekly Review Skill

Ordered linear steps (no branching, no parallelism - v0.1 workflow rules):

1. **Inbox zero (10 min)** - every inbox item becomes triaged, planned,
   deferred or rejected. Nothing stays in `inbox`.
2. **Four-domain three questions (30 min)** - for each of venture /
   career / learning / investing: what moved, what is blocked, what
   is the single next action.
3. **Cross-domain connections (5 min)** - register any conflict as a
   conflict entry; never auto-resolve.
4. **Next week three priorities (5 min)**.
5. **Decision log + rejection list (10 min)** - a review without a
   rejection list is incomplete.

Output artifact `review-notes` must contain the literal sections
`rejections` and `next-week` (checked by the acceptance block above).
