import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  GeminiAdapter, QwenCodeAdapter,
} from '../src/cli-agent-adapter.js';
import type { DispatchIntent } from '@paos/runtime';

const CONTRACT = {
  contract_version: '1.1',
  objective: 'Fix "the parser" & rm -rf <tmp> | whoami %PATH%',
  inputs: { workspace: process.cwd() },
};

function fake(result: Partial<{
  stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; error?: string;
}>): { execFn: (r: import('../src/process-exec.js').ExecRequest) => Promise<import('../src/process-exec.js').ExecResult>; calls: import('../src/process-exec.js').ExecRequest[] } {
  const calls: import('../src/process-exec.js').ExecRequest[] = [];
  return {
    calls,
    execFn: async (req) => {
      calls.push(req);
      return {
        stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false,
        ...result,
      };
    },
  };
}

function contractHashOf(contract: unknown): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function intent(contractHash: string): DispatchIntent {
  return {
    id: 'dsp_1', workflowRunId: 'wfr_1', stepId: 's1',
    adapterId: 'a', provider: 'gemini', idempotencyKey: 'k',
    contractHash, state: 'dispatching', supportsServerIdempotency: false,
    attemptCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CONTRACT_HASH = contractHashOf(CONTRACT);

describe('GeminiAdapter', () => {
  it('defaults to read-only (plan mode) and widens only when asked', async () => {
    const ro = await new GeminiAdapter({ execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath }).probe();
    expect(ro.enforcedCapabilities).toContain('fs.read.workspace');
    expect(ro.enforcedCapabilities).toContain('structured_output');
    expect(ro.enforcedCapabilities).not.toContain('fs.write.workspace');

    const write = await new GeminiAdapter({
      execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath, approvalMode: 'default',
    }).probe();
    expect(write.enforcedCapabilities).toContain('fs.write.workspace');
  });

  it('never probes auth - reports unverified, even when opt-in', async () => {
    const spy = fake({ exitCode: 0 });
    const adapter = new GeminiAdapter({ execFn: spy.execFn, executable: process.execPath, probeAuth: true });
    const health = await adapter.probe();
    // supportsAuthProbe=false -> the auth command is never executed.
    expect(spy.calls.map((c) => c.args.join(' '))).toEqual(['--version']);
    expect(health.authenticated).toBe(false);
    expect(health.diagnostics.map((d) => d.code)).toContain('AUTH_UNVERIFIED');
    expect(health.diagnostics.map((d) => d.nextStep ?? '').join(' ')).toContain('gemini auth login');
  });

  it('delivers the untrusted objective over stdin, never argv', async () => {
    const spy = fake({ exitCode: 0, stdout: 'ok' });
    const adapter = new GeminiAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(CONTRACT_HASH), { plan });

    expect(outcome.transport).toBe('ok');
    const req = spy.calls[spy.calls.length - 1];
    expect(req?.cwd).toBe(process.cwd());
    // `-p` reads the prompt from stdin; `--approval-mode plan` keeps it read-only.
    expect(req?.args.slice(0, 3)).toEqual(['-p', '--approval-mode', 'plan']);
    expect(req?.args.join(' ')).not.toContain('rm -rf');
    expect(req?.args.some((a) => a.includes('whoami'))).toBe(false);
    expect(req?.stdin).toBe(CONTRACT.objective);
  });

  it('maps a non-zero exit to a task failure, not transport failure', async () => {
    const spy = fake({ exitCode: 3, stderr: 'boom' });
    const adapter = new GeminiAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(CONTRACT_HASH), { plan });
    expect(outcome.transport).toBe('ok');
    const obs = await adapter.reconcile(outcome.providerTaskId ?? '');
    expect(obs.providerStatus).toBe('failed');
    expect(obs.exitCode).toBe(3);
  });

  it('reports a timeout as unknown, never as failed', async () => {
    const spy = fake({ exitCode: null, timedOut: true });
    const adapter = new GeminiAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(CONTRACT_HASH), { plan });
    expect(outcome.transport).toBe('timeout');
    const obs = await adapter.reconcile(outcome.providerTaskId ?? '');
    expect(obs.providerStatus).toBe('unknown');
  });

  it('is an AgentAdapter with stable identity', () => {
    const a = new GeminiAdapter({ execFn: fake({}).execFn, executable: process.execPath });
    expect(a.id).toBe('gemini-adapter');
    expect(a.provider).toBe('gemini');
  });
});

describe('QwenCodeAdapter', () => {
  it('defaults to read-only and widens only when asked', async () => {
    const ro = await new QwenCodeAdapter({ execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath }).probe();
    expect(ro.enforcedCapabilities).toEqual(['fs.read.workspace', 'structured_output']);

    const write = await new QwenCodeAdapter({
      execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath, approvalMode: 'yolo',
    }).probe();
    expect(write.enforcedCapabilities).toContain('fs.write.workspace');
  });

  it('never probes auth (qwen-code dropped auth status) and hints out-of-band verify', async () => {
    const spy = fake({ exitCode: 0 });
    const adapter = new QwenCodeAdapter({ execFn: spy.execFn, executable: process.execPath, probeAuth: true });
    const health = await adapter.probe();
    expect(spy.calls.map((c) => c.args.join(' '))).toEqual(['--version']);
    expect(health.authenticated).toBe(false);
    expect(health.diagnostics.map((d) => d.nextStep ?? '').join(' ')).toContain('API key');
  });

  it('delivers the objective over stdin and uses -p + plan mode', async () => {
    const spy = fake({ exitCode: 0, stdout: 'ok' });
    const adapter = new QwenCodeAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(CONTRACT_HASH), { plan });

    expect(outcome.transport).toBe('ok');
    const req = spy.calls[spy.calls.length - 1];
    expect(req?.args.slice(0, 3)).toEqual(['-p', '--approval-mode', 'plan']);
    expect(req?.args.join(' ')).not.toContain('rm -rf');
    expect(req?.stdin).toBe(CONTRACT.objective);
  });

  it('refuses to fabricate a confirmed remote cancel', async () => {
    const adapter = new QwenCodeAdapter({ execFn: fake({}).execFn, executable: process.execPath });
    const res = await adapter.cancel('wfr_1');
    expect(res.local).toBe('stopped');
    expect(res.remote).toBe('unconfirmed');
  });

  it('is an AgentAdapter with stable identity', () => {
    const a = new QwenCodeAdapter({ execFn: fake({}).execFn, executable: process.execPath });
    expect(a.id).toBe('qwen-code-adapter');
    expect(a.provider).toBe('qwen-code');
  });
});
