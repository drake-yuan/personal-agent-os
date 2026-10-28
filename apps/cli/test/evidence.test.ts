import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentAdapter, AdapterHealth } from '@paos/adapters';
import {
  workspaceCheckContext, recordingAdapter, changedPathsIn,
  UNVERIFIABLE_PATH, type RunEvidence,
} from '../src/evidence.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'paos-evidence-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function health(): AdapterHealth {
  return {
    installed: true, authenticated: true,
    declaredCapabilities: ['fs.read.workspace'],
    enforcedCapabilities: ['fs.read.workspace'],
    enforcedIsolation: 'workspace-fs', unconfined: false,
    liveConnectivity: true, maxSilentMs: 1000,
    supportsServerIdempotency: false, diagnostics: [],
  };
}

/** Minimal adapter that reports a fixed observed exit code. */
function stubAdapter(exitCode: number | null): AgentAdapter {
  return {
    id: 'stub-adapter',
    provider: 'stub',
    probe: async () => health(),
    plan: async (input) => ({
      provider: 'stub', command: ['stub'], cwd: input.workspace,
      env: {}, estimatedMaxSilentMs: 1000,
    }),
    dispatch: async () => ({ transport: 'ok', providerTaskId: 'stub-1' }),
    stream: async function* () { /* no events */ },
    cancel: async () => ({ local: 'stopped', remote: 'unconfirmed' }),
    reconcile: async (providerTaskId) => ({
      providerTaskId, providerStatus: 'completed', transport: 'ok', exitCode,
    }),
    mapResult: () => ({}),
  };
}

describe('workspace evidence', () => {
  it('derives artifact hashes and JSON from real files', () => {
    const ws = path.join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, 'out.json'), '{"a":1}');

    const ctx = workspaceCheckContext({ workspace: ws, evidence: {} });
    const expected = createHash('sha256').update('{"a":1}').digest('hex');
    expect(ctx.artifactSha256('out.json')).toBe(expected);
    expect(ctx.artifactJson('out.json')).toEqual({ a: 1 });
  });

  it('fails closed on missing artifacts and on paths escaping the workspace', () => {
    const ws = path.join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    const ctx = workspaceCheckContext({ workspace: ws, evidence: {} });
    expect(ctx.artifactSha256('missing.json')).toBeUndefined();
    expect(ctx.artifactSha256('../escaped.json')).toBeUndefined();
    expect(ctx.evidenceAgeDays('missing.json')).toBeUndefined();
  });

  it('reports an unobserved exit code as undefined so checks fail closed', () => {
    const ws = path.join(dir, 'ws');
    const unobserved = workspaceCheckContext({ workspace: ws, evidence: {} });
    expect(unobserved.exitCode('test')).toBeUndefined();

    const observed = workspaceCheckContext({ workspace: ws, evidence: { exitCode: 0 } });
    expect(observed.exitCode('test')).toBe(0);
  });

  it('reports real changed paths in a git repo and the sentinel when not', () => {
    const repo = path.join(dir, 'repo');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init'], { cwd: repo });
    writeFileSync(path.join(repo, 'added.txt'), 'x');
    expect(changedPathsIn(repo)).toContain('added.txt');

    const plain = path.join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    expect(changedPathsIn(plain)).toEqual([UNVERIFIABLE_PATH]);
  });

  it('recordingAdapter captures what the real adapter observed', async () => {
    const evidence: RunEvidence = {};
    const wrapped = recordingAdapter(stubAdapter(7), evidence);
    const plan = await wrapped.plan({ contract: {}, workspace: dir });

    expect(evidence.exitCode).toBeUndefined();
    const outcome = await wrapped.dispatch({ id: 'dsp_1' } as never, { plan });
    expect(outcome.providerTaskId).toBe('stub-1');
    expect(evidence.providerTaskId).toBe('stub-1');

    const obs = await wrapped.reconcile('stub-1');
    expect(obs.exitCode).toBe(7);
    expect(evidence.exitCode).toBe(7);
  });
});
