import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CodexAdapter, ClaudeCodeAdapter, BaseCliAdapter,
} from '../src/cli-agent-adapter.js';
import {
  quoteCmdArg, spawnTarget, resolveExecutable, filterEnv, DEFAULT_ENV_ALLOWLIST,
  MAX_CAPTURE_BYTES, defaultExec, type ExecRequest, type ExecResult,
} from '../src/process-exec.js';
import type { DispatchIntent } from '@paos/runtime';

const CONTRACT = {
  contract_version: '1.1',
  objective: 'Fix "the parser" & rm -rf <tmp> | whoami %PATH%',
  inputs: { workspace: process.cwd() },
};

function fake(result: Partial<ExecResult>): {
  execFn: (r: ExecRequest) => Promise<ExecResult>;
  calls: ExecRequest[];
} {
  const calls: ExecRequest[] = [];
  return {
    calls,
    execFn: async (req: ExecRequest) => {
      calls.push(req);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, ...result };
    },
  };
}

/** Same key the Runtime uses for `contractHash` (see pipeline.runContract). */
function contractHashOf(contract: unknown): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function intent(contractHash: string): DispatchIntent {
  return {
    id: 'dsp_1', workflowRunId: 'wfr_1', stepId: 's1',
    adapterId: 'a', provider: 'codex', idempotencyKey: 'k',
    contractHash, state: 'dispatching', supportsServerIdempotency: false,
    attemptCount: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const CONTRACT_HASH = contractHashOf(CONTRACT);

describe('cmd.exe argument quoting (Windows shims)', () => {
  it('leaves harmless tokens unquoted', () => {
    expect(quoteCmdArg('exec')).toBe('exec');
    expect(quoteCmdArg('workspace-write')).toBe('workspace-write');
  });

  it('neutralises every cmd metacharacter', () => {
    for (const ch of ['&', '|', '<', '>', '^', '%', '(', ')', '!']) {
      const q = quoteCmdArg(`a${ch}b`);
      expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
      expect(q).toContain(`^${ch}`);
    }
  });

  it('escapes quotes and the backslashes in front of them', () => {
    expect(quoteCmdArg('say "hi"')).toBe('"say \\"hi\\""');
  });

  it('doubles trailing backslashes when the arg must be quoted', () => {
    // A bare token with no metacharacter stays unquoted, so a trailing
    // backslash is harmless; one that needs quotes gets them doubled.
    expect(quoteCmdArg('C:\\dir\\')).toBe('C:\\dir\\');
    expect(quoteCmdArg('C:\\my dir\\')).toBe('"C:\\my dir\\\\"');
  });
});

describe('spawn target selection', () => {
  it('never requests a shell on POSIX', () => {
    if (process.platform === 'win32') return;
    const t = spawnTarget('/usr/bin/codex', ['exec', 'x']);
    expect(t.file).toBe('/usr/bin/codex');
    expect(t.args).toEqual(['exec', 'x']);
  });

  it('wraps .cmd shims in cmd.exe and passes flags verbatim', () => {
    if (process.platform !== 'win32') return;
    const t = spawnTarget('C:\\bin\\codex.cmd', ['exec', '-s', 'read-only']);
    expect(t.file.toLowerCase()).toContain('cmd.exe');
    expect(t.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(t.args[3]).toContain('codex.cmd');
    expect(t.args[3]).toContain('-s read-only');
    expect(t.windowsVerbatimArguments).toBe(true);
  });
});

describe('executable resolution and environment', () => {
  it('resolves a binary from PATH', () => {
    const found = resolveExecutable(process.platform === 'win32' ? 'cmd' : 'sh');
    expect(found).toBeDefined();
  });

  it('returns undefined for a name that does not exist', () => {
    expect(resolveExecutable('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });

  it('resolves an explicit existing path', () => {
    const target = process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh';
    const found = resolveExecutable(target);
    if (found) expect(path.basename(found).toLowerCase()).toContain(process.platform === 'win32' ? 'cmd' : 'sh');
  });

  it('filters the inherited environment down to an allowlist', () => {
    process.env.PAOS_TEST_LEAK_TOKEN = 'should-not-propagate';
    const env = filterEnv(DEFAULT_ENV_ALLOWLIST, { EXTRA: 'ok' });
    expect(env.EXTRA).toBe('ok');
    expect(env.PAOS_TEST_LEAK_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });
});

describe('CodexAdapter', () => {
  it('reports the capabilities its sandbox flags actually grant', async () => {
    const readOnly = new CodexAdapter({ execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath });
    const ro = await readOnly.probe();
    expect(ro.enforcedCapabilities).toContain('fs.read.workspace');
    expect(ro.enforcedCapabilities).not.toContain('fs.write.workspace');

    const write = new CodexAdapter({
      execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath, sandboxMode: 'workspace-write',
    });
    expect((await write.probe()).enforcedCapabilities).toContain('fs.write.workspace');
  });

  it('does not probe auth unless asked (offline-safe default)', async () => {
    const spy = fake({ exitCode: 0 });
    const adapter = new CodexAdapter({ execFn: spy.execFn, executable: process.execPath });
    await adapter.probe();
    expect(spy.calls.map((c) => c.args.join(' '))).toEqual(['--version']);
  });

  it('probes the vendor status command when opted in', async () => {
    const spy = fake({ exitCode: 0 });
    const adapter = new CodexAdapter({ execFn: spy.execFn, executable: process.execPath, probeAuth: true });
    const health = await adapter.probe();
    expect(spy.calls.map((c) => c.args.join(' '))).toEqual(['--version', 'login status']);
    expect(health.authenticated).toBe(true);
    expect(health.diagnostics.map((d) => d.code)).not.toContain('AUTH_UNVERIFIED');
  });

  it('turns a failing auth probe into an actionable diagnostic', async () => {
    const calls: ExecRequest[] = [];
    const adapter = new ClaudeCodeAdapter({
      executable: process.execPath,
      probeAuth: true,
      execFn: async (req) => {
        calls.push(req);
        const base = { stdout: '', stderr: '', timedOut: false, truncated: false };
        return req.args[0] === '--version'
          ? { ...base, exitCode: 0 }
          : { ...base, exitCode: 1, stderr: 'not logged in' };
      },
    });
    const health = await adapter.probe();
    expect(health.authenticated).toBe(false);
    expect(health.diagnostics.map((d) => d.code)).toContain('E_AUTH_MISSING');
    expect(health.diagnostics.map((d) => d.nextStep ?? '').join(' ')).toContain('claude auth login');
  });

  it('reports an auth probe that overruns its timeout instead of guessing', async () => {
    const adapter = new ClaudeCodeAdapter({
      executable: process.execPath,
      probeAuth: true,
      execFn: async (req) => ({
        stdout: '', stderr: '',
        exitCode: req.args[0] === '--version' ? 0 : null,
        timedOut: req.args[0] !== '--version',
        truncated: false,
      }),
    });
    const health = await adapter.probe();
    expect(health.authenticated).toBe(false);
    expect(health.diagnostics.map((d) => d.code)).toContain('E_AUTH_PROBE_TIMEOUT');
  });

  it('never claims authentication without evidence', async () => {
    const health = await new CodexAdapter({ execFn: fake({ exitCode: 0 }).execFn, executable: process.execPath }).probe();
    expect(health.authenticated).toBe(false);
    expect(health.diagnostics.map((d) => d.code)).toContain('AUTH_UNVERIFIED');
  });

  it('reports uninstalled honestly and drops every enforced capability', async () => {
    const health = await new CodexAdapter({
      execFn: fake({ exitCode: 0 }).execFn,
      executable: '/nonexistent/paos-codex',
    }).probe();
    expect(health.installed).toBe(false);
    expect(health.enforcedCapabilities).toEqual([]);
    expect(health.enforcedIsolation).toBe('none');
    expect(health.unconfined).toBe(true);
  });

  it('delivers the untrusted objective over stdin, never through argv', async () => {
    const spy = fake({ exitCode: 0, stdout: 'ok' });
    const adapter = new CodexAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(contractHashOf(CONTRACT)), { plan });

    expect(outcome.transport).toBe('ok');
    const req = spy.calls[spy.calls.length - 1];
    expect(req?.cwd).toBe(process.cwd());
    expect(req?.args.slice(0, 3)).toEqual(['exec', '-s', 'read-only']);
    expect(req?.args.join(' ')).not.toContain('rm -rf');
    expect(req?.args.some((a) => a.includes('whoami'))).toBe(false);
    expect(req?.stdin).toBe(CONTRACT.objective);
  });

  it('treats a non-zero exit as a task failure, not a transport failure', async () => {
    const spy = fake({ exitCode: 3, stderr: 'boom' });
    const adapter = new CodexAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(CONTRACT_HASH), { plan });
    expect(outcome.transport).toBe('ok');
    expect(outcome.providerTaskId).toBeDefined();
    const obs = await adapter.reconcile(outcome.providerTaskId ?? '');
    expect(obs.providerStatus).toBe('failed');
  });

  it('reports a timeout as unknown_outcome material, never as failed', async () => {
    const spy = fake({ exitCode: null, timedOut: true });
    const adapter = new CodexAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    const outcome = await adapter.dispatch(intent(CONTRACT_HASH), { plan });
    expect(outcome.transport).toBe('timeout');
    const obs = await adapter.reconcile(outcome.providerTaskId ?? '');
    expect(obs.providerStatus).toBe('unknown');
  });

  it('refuses to fabricate a confirmed remote cancel', async () => {
    const adapter = new CodexAdapter({ execFn: fake({}).execFn, executable: process.execPath });
    const res = await adapter.cancel('wfr_1');
    expect(res.local).toBe('stopped');
    expect(res.remote).toBe('unconfirmed');
  });
});

describe('ClaudeCodeAdapter', () => {
  it('never passes a permission-bypass flag', async () => {
    const spy = fake({ exitCode: 0 });
    const adapter = new ClaudeCodeAdapter({ execFn: spy.execFn, executable: process.execPath });
    const plan = await adapter.plan({ contract: CONTRACT, workspace: process.cwd() });
    expect(plan.command.slice(1)).toEqual(['-p', '--permission-prompts', 'none']);
    await adapter.dispatch(intent(CONTRACT_HASH), { plan });
    const req = spy.calls[spy.calls.length - 1];
    expect(req?.args.join(' ')).not.toContain('dangerously-skip-permissions');
    expect(req?.args.join(' ')).not.toContain('allow-dangerously-skip-permissions');
  });

  it('maps result observations without ever asserting acceptance', () => {
    const adapter = new ClaudeCodeAdapter({ execFn: fake({}).execFn, executable: process.execPath });
    const result = adapter.mapResult({ provider: 'claude-code', stdout: 'done', exitCode: 0 }) as Record<string, unknown>;
    expect(result.provider_status).toBe('completed');
    expect(result).not.toHaveProperty('verdict');
    expect(result).not.toHaveProperty('accepted');
  });

  it('is an AgentAdapter', () => {
    const a: BaseCliAdapter = new ClaudeCodeAdapter({ execFn: fake({}).execFn, executable: process.execPath });
    expect(a.id).toBe('claude-code-adapter');
    expect(a.provider).toBe('claude-code');
  });
});

describe('real subprocess (opt-in)', () => {
  it('actually executes a process without a shell', async () => {
    const executable = resolveExecutable(process.platform === 'win32' ? 'cmd' : 'sh');
    if (!executable) return;
    const result = await defaultExec({
      executable,
      args: process.platform === 'win32' ? ['/c', 'echo paos'] : ['-c', 'echo paos'],
      timeoutMs: 5000,
    });
    expect(result.stdout.trim()).toBe('paos');
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('reports ENOENT instead of throwing', async () => {
    const result = await defaultExec({ executable: '/nonexistent/paos-binary', args: [], timeoutMs: 3000 });
    expect(result.error).toBeDefined();
    expect(result.exitCode).toBeNull();
  });

  it('kills a process that overruns its budget', async () => {
    // Use node itself: a shell sleep loop is not portable across platforms.
    const result = await defaultExec({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
  });

  it('captures and reports the cap as a constant', () => {
    expect(MAX_CAPTURE_BYTES).toBeGreaterThan(0);
  });
});
