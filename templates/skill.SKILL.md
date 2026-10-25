---
name: my-skill
description: One sentence describing when this skill applies. Used by the router for matching.
allowed-tools: [Read, Write]
acceptance:
  - checker: artifact.exists
    args:
      artifact_ids: ["my-output"]
permissions:
  filesystem: workspace-only
  network: none
evals:
  cases: evals/cases.jsonl
input_schema: paos://schemas/my-input/1.0.0
output_schema: paos://schemas/my-output/1.0.0
---

# My Skill

Standard SKILL.md fields: `name`, `description`, `allowed-tools`.
PAOS extension fields: `acceptance`, `permissions`, `evals`, `input_schema`, `output_schema`.
Unknown extension fields are read compatibly but fail strict publish validation.

Body: ordered steps. No branching, no parallel execution (v0.1 linear workflow rules).
