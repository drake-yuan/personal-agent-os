import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchemaById, schemaPathFor, SCHEMA_ROOT_NOT_FOUND } from '../src/schema-store.js';
import { validate } from '../src/validate.js';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

const DEMO_CONTRACT = JSON.parse(
  readFileSync(path.join(repoRoot(), 'demo/contracts/software-change-task.json'), 'utf8'),
) as Record<string, unknown>;

describe('paos:// schema store', () => {
  it('loads the task contract schema by id', () => {
    const { schema } = loadSchemaById('paos://schemas/agent-task-contract/1.1.0');
    expect((schema as { title: string }).title).toBe('AgentTaskContract v1.1');
  });

  it('rejects non-paos ids (no remote fetch, SSRF defence)', () => {
    expect(() => schemaPathFor('https://evil.example/schema.json')).toThrow(/invalid paos:\/\//);
    expect(() => schemaPathFor('paos://other/name/1.0.0')).toThrow();
    expect(() => schemaPathFor('paos://schemas/name/latest')).toThrow();
  });

  it('the demo contract validates against schema 1.1', () => {
    const { schema } = loadSchemaById('paos://schemas/agent-task-contract/1.1.0');
    const result = validate(DEMO_CONTRACT as never, schema as never);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('contract schema rejects wrong version and unknown fields', () => {
    const { schema } = loadSchemaById('paos://schemas/agent-task-contract/1.1.0');
    expect(validate({ ...DEMO_CONTRACT, contract_version: '1.0' } as never, schema as never).ok).toBe(false);
    expect(validate({ ...DEMO_CONTRACT, evil: 'x' } as never, schema as never).ok).toBe(false);
  });

  it('contract schema rejects bad risk level and external schema ids', () => {
    const { schema } = loadSchemaById('paos://schemas/agent-task-contract/1.1.0');
    const bad = JSON.parse(JSON.stringify(DEMO_CONTRACT)) as {
      policy: { risk_level: string };
      expected_output: { schema_id: string };
    };
    bad.policy.risk_level = 'R9';
    expect(validate(bad as never, schema as never).ok).toBe(false);
    bad.policy.risk_level = 'R2';
    bad.expected_output.schema_id = 'https://evil.example/result.json';
    expect(validate(bad as never, schema as never).ok).toBe(false);
  });

  it('the result contract schema accepts an observation-only payload', () => {
    const { schema } = loadSchemaById('paos://schemas/agent-result-contract/1.1.0');
    const ok = {
      result_version: '1.1', provider: 'codex', provider_status: 'completed',
      transport_status: 'ok', raw_result_ref: 'artifact_x',
      artifacts: [], usage: { duration_s: 1, tokens: null, cost_usd: null, cost_source: 'unknown' }, errors: [],
    };
    expect(validate(ok as never, schema as never).ok).toBe(true);
    const bad = { ...ok, accepted: true }; // adapters may never claim acceptance
    expect(validate(bad as never, schema as never).ok).toBe(false);
  });
});
