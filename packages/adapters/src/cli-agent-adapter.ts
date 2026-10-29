/**
 * Real CLI-backed adapters: Codex and Claude Code (design Section 10.1, G2).
 *
 * These change nothing about the adapter contract - they implement the same
 * observation-only interface as the demo adapter. What changes is that
 * dispatch now starts a real local process, so four limits are enforced here:
 *
 *  - The objective travels over STDIN, never through argv, so untrusted
 *    contract text can never become argument syntax.
 *  - The sandbox mode advertised in `probe()` is the mode actually passed on
 *    the command line. A read-only adapter does not claim write access; the
 *    Router may therefore refuse it, which is the correct outcome.
 *  - No vendor "skip permissions" flag is used. Unattended privilege
 *    escalation is not something this OS should offer. Claude Code is told
 *    to auto-DENY permission prompts (`--permission-prompts none`) so a
 *    request for extra privileges cannot block forever unnoticed.
 *  - A non-zero exit is a TASK failure, never a transport failure. Only a
 *    spawn error or a timeout moves the outbox off `ok`, and a timeout maps
 *    to `unknown_outcome` rather than `failed`.
 *
 * Authentication is deliberately NOT probed by running a login command: that
 * would either hang on network or touch credentials during discovery.
 * `authenticated` stays false with an explicit diagnostic instead.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type {
  AgentAdapter, AdapterHealth, DispatchOutcome, DispatchPlan,
  ProviderObservation, RunEvent, VendorRaw, CancelOutcome,
} from './types.js';
import type { DispatchIntent } from '@paos/runtime';
import {
  DEFAULT_ENV_ALLOWLIST, defaultExec, filterEnv, resolveExecutable,
  type ExecFn, type ExecRequest,
} from './process-exec.js';

/** Sandbox policy passed to Codex; `danger-full-access` is never used. */
export type CodexSandboxMode = 'read-only' | 'workspace-write';

export interface CliAgentOptions {
  /** Injectable for tests; defaults to a real subprocess. */
  execFn?: ExecFn;
  /** Explicit executable path; overrides PATH resolution. */
  executable?: string;
  /** Extra environment variables merged over the allowlist. */
  env?: Record<string, string>;
  /** Cap on a single dispatch. Over budget -> timeout -> unknown_outcome. */
  timeoutMs?: number;
  /** Opt in to a real auth probe: the vendor status command, short timeout. */
  probeAuth?: boolean;
  /** Codex only. Defaults to the least-privilege mode. */
  sandboxMode?: CodexSandboxMode;
  /** Override the inherited-environment allowlist. */
  envAllowlist?: readonly string[];
}

interface RunRecord {
  providerTaskId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  transport: DispatchOutcome['transport'];
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;
const AUTH_PROBE_TIMEOUT_MS = 20 * 1000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Contracts arrive as `unknown`; only the objective is ever read. */
function objectiveOf(contract: unknown): string {
  const objective = (contract as { objective?: unknown })?.objective;
  return typeof objective === 'string' ? objective : '';
}

/**
 * Shared behaviour for local CLI agents. Subclasses supply only: identity,
 * the binary name, `--version` args, the constant dispatch argv, and which
 * capabilities those flags actually grant.
 */
export abstract class BaseCliAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly provider: string;
  protected abstract readonly binary: string;
  protected abstract readonly versionArgs: string[];
  /** Vendor status command used only when `probeAuth` is opted in. */
  protected abstract readonly authArgs: string[];
  protected readonly timeoutMs: number;
  protected readonly envAllowlist: readonly string[];
  private readonly execFn: ExecFn;
  private readonly explicitExecutable?: string;
  private readonly extraEnv: Record<string, string>;
  private readonly runs = new Map<string, RunRecord>();
  private readonly probeAuth: boolean;
  /**
   * Whether this vendor exposes a non-hanging auth-status command. When
   * false, `probe()` never runs an auth probe and reports AUTH_UNVERIFIED
   * with a vendor-specific hint - safer than guessing a subcommand that may
   * have been removed (e.g. qwen-code dropped `auth status`).
   */
  protected supportsAuthProbe = true;
  /**
   * Prompt text keyed by contract hash, captured at `plan()` time.
   * Keyed by content so concurrent dispatches cannot cross wires, and so
   * the prompt reaches stdin without ever becoming an argv element.
   */
  private readonly prompts = new Map<string, string>();

  constructor(opts: CliAgentOptions = {}) {
    this.execFn = opts.execFn ?? defaultExec;
    this.explicitExecutable = opts.executable;
    this.extraEnv = opts.env ?? {};
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.envAllowlist = opts.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;
    this.probeAuth = opts.probeAuth ?? false;
  }

  /** Capabilities actually granted by the flags we pass. */
  protected abstract enforcedFor(): {
    capabilities: string[];
    isolation: AdapterHealth['enforcedIsolation'];
    unconfined: boolean;
  };

  /** argv for one non-interactive task. Must contain no untrusted text. */
  protected abstract buildDispatchArgs(): string[];

  protected resolve(): string | undefined {
    // An explicit path is honoured only when it exists: claiming "installed"
    // for a path that cannot run would let a dead adapter take work.
    if (this.explicitExecutable) {
      return existsSync(this.explicitExecutable) ? this.explicitExecutable : undefined;
    }
    return resolveExecutable(this.binary);
  }

  protected buildEnv(): Record<string, string> {
    return filterEnv(this.envAllowlist, this.extraEnv);
  }

  protected request(req: { executable: string; args: string[]; cwd?: string; stdin?: string; timeoutMs?: number }): ExecRequest {
    return {
      executable: req.executable,
      args: req.args,
      cwd: req.cwd,
      env: this.buildEnv(),
      stdin: req.stdin,
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
    };
  }

  async probe(): Promise<AdapterHealth> {
    const executable = this.resolve();
    const granted = this.enforcedFor();
    if (!executable) {
      return this.health({
        installed: false, granted,
        diagnostics: [{
          code: 'E_NOT_INSTALLED',
          message: `${this.binary} not found on PATH`,
          nextStep: `install ${this.binary}, or pass an explicit executable path`,
        }],
      });
    }
    const version = await this.execFn(this.request({
      executable, args: this.versionArgs, timeoutMs: PROBE_TIMEOUT_MS,
    }));
    const versionOk = version.exitCode === 0 && version.error === undefined;
    const auth = versionOk && this.probeAuth && this.supportsAuthProbe
      ? await this.execFn(this.request({
        executable, args: this.authArgs, timeoutMs: AUTH_PROBE_TIMEOUT_MS,
      }))
      : undefined;

    const diagnostics: AdapterHealth['diagnostics'] = [];
    if (!versionOk) {
      diagnostics.push({
        code: 'E_VERSION_FAILED',
        message: `${this.binary} ${this.versionArgs.join(' ')} exited ${version.exitCode ?? 'killed'}${version.error ? ` (${version.error})` : ''}`,
        nextStep: 'reinstall the CLI',
      });
    } else if (auth === undefined) {
      diagnostics.push({
        code: 'AUTH_UNVERIFIED',
        message: 'authentication not probed (opt in with probeAuth)',
        nextStep: `check \`${this.loginHint()}\` yourself before dispatching`,
      });
    } else if (auth.timedOut) {
      diagnostics.push({
        code: 'E_AUTH_PROBE_TIMEOUT',
        message: `${this.binary} ${this.authArgs.join(' ')} timed out`,
        nextStep: `run \`${this.loginHint()}\` manually; network may be unreachable`,
      });
    } else if (auth.exitCode !== 0) {
      diagnostics.push({
        code: 'E_AUTH_MISSING',
        message: `${this.binary} reports no active credentials`,
        nextStep: `run \`${this.loginHint()}\``,
      });
    }
    const authenticated = auth !== undefined && !auth.timedOut && auth.exitCode === 0;

    return this.health({ installed: versionOk, granted, authenticated, diagnostics });
  }

  /** Provider-correct login guidance; never a hardcoded vendor's command. */
  protected loginHint(): string {
    return `${this.binary} login`;
  }

  private health(input: {
    installed: boolean;
    granted: { capabilities: string[]; isolation: AdapterHealth['enforcedIsolation']; unconfined: boolean };
    authenticated?: boolean;
    diagnostics: AdapterHealth['diagnostics'];
  }): AdapterHealth {
    const { installed, granted } = input;
    return {
      installed,
      authenticated: input.authenticated ?? false,
      declaredCapabilities: granted.capabilities,
      enforcedCapabilities: installed ? granted.capabilities : [],
      enforcedIsolation: installed ? granted.isolation : 'none',
      // Fail closed: an adapter we could not run cannot be credited with
      // isolation we have no evidence for.
      unconfined: installed ? granted.unconfined : true,
      liveConnectivity: installed,
      maxSilentMs: installed ? this.timeoutMs : 0,
      supportsServerIdempotency: false,
      // Exactly one auth verdict per probe; no duplicate "unverified" line
      // once real evidence has been collected.
      diagnostics: input.diagnostics,
    };
  }

  async plan(input: { contract: unknown; workspace: string }): Promise<DispatchPlan> {
    const executable = this.resolve() ?? this.binary;
    // Same key the Runtime uses for `contractHash`, so dispatch can find it.
    this.prompts.set(sha256(JSON.stringify(input.contract)), objectiveOf(input.contract));
    return {
      provider: this.provider,
      command: [executable, ...this.buildDispatchArgs()],
      cwd: input.workspace,
      env: this.buildEnv(),
      estimatedMaxSilentMs: this.timeoutMs,
    };
  }

  async dispatch(intent: DispatchIntent, ctx: { plan: DispatchPlan }): Promise<DispatchOutcome> {
    const executable = this.resolve();
    if (!executable) {
      return { transport: 'connection_error', error: `${this.binary} not installed` };
    }
    const result = await this.execFn(this.request({
      executable,
      args: this.buildDispatchArgs(),
      cwd: ctx.plan.cwd,
      stdin: this.prompts.get(intent.contractHash) ?? '',
    }));
    const providerTaskId = `${this.provider}-${randomUUID()}`;
    const transport: DispatchOutcome['transport'] = result.timedOut
      ? 'timeout'
      : result.error !== undefined
        ? 'connection_error'
        : 'ok';
    this.runs.set(providerTaskId, {
      providerTaskId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      transport,
      error: result.error ?? (result.timedOut ? `timeout after ${this.timeoutMs}ms` : undefined),
    });
    return {
      transport,
      providerTaskId,
      error: transport === 'ok' ? undefined : (result.error ?? 'dispatch timeout'),
    };
  }

  async *stream(runId: string): AsyncIterable<RunEvent> {
    const at = new Date().toISOString();
    yield { at, eventType: `${this.provider}.start`, detail: `run ${runId}` };
    for (const record of this.runs.values()) {
      const lines = record.stdout.split('\n').filter((l) => l.trim().length > 0).slice(0, 50);
      for (const line of lines) {
        yield { at, eventType: `${this.provider}.stdout`, detail: line.slice(0, 500) };
      }
      yield {
        at,
        eventType: `${this.provider}.exit`,
        detail: `exit=${record.exitCode ?? 'killed'} timedOut=${record.timedOut}`,
      };
    }
  }

  async cancel(_runId: string): Promise<CancelOutcome> {
    // No child handle survives dispatch, and no CLI exposes a confirmable
    // remote cancel. Say so instead of reporting a confirmation we lack.
    return { local: 'stopped', remote: 'unconfirmed' };
  }

  async reconcile(providerTaskId: string): Promise<ProviderObservation> {
    const record = this.runs.get(providerTaskId);
    if (!record) {
      // Not observable: omit the exit code so verification fails closed
      // instead of inventing a success.
      return { providerTaskId, providerStatus: 'unknown', transport: 'ok' };
    }
    return {
      providerTaskId,
      providerStatus: record.timedOut ? 'unknown' : record.exitCode === 0 ? 'completed' : 'failed',
      transport: record.transport,
      exitCode: record.exitCode,
    };
  }

  /** Observation only - evidence for the Verifier, never a verdict. */
  mapResult(raw: VendorRaw): unknown {
    return {
      result_version: '1.1',
      provider: raw.provider,
      provider_status: raw.exitCode === 0 ? 'completed' : 'failed',
      transport_status: raw.exitCode === undefined ? 'unknown' : 'ok',
      native_run: { run_id: raw.provider, exit_code: raw.exitCode ?? null },
      raw_result_ref: raw.stdout ? `sha256:${sha256(raw.stdout)}` : undefined,
      artifacts: [],
      usage: { duration_s: null, tokens: null, cost_usd: null, cost_source: 'unknown' },
      errors: raw.stderr ? [{ code: 'stderr', message: raw.stderr.slice(0, 1000) }] : [],
    };
  }

  /** Test seam: inspect what a run recorded. Not part of AgentAdapter. */
  record(providerTaskId: string): RunRecord | undefined {
    return this.runs.get(providerTaskId);
  }
}

/**
 * Codex CLI. The sandbox mode is passed explicitly and is exactly what
 * `probe()` advertises: `read-only` never claims write capability.
 */
export class CodexAdapter extends BaseCliAdapter {
  readonly id = 'codex-adapter';
  readonly provider = 'codex';
  protected readonly binary = 'codex';
  protected readonly versionArgs = ['--version'];
  protected readonly authArgs = ['login', 'status'];
  private readonly sandboxMode: CodexSandboxMode;

  constructor(opts: CliAgentOptions = {}) {
    super(opts);
    this.sandboxMode = opts.sandboxMode ?? 'read-only';
  }

  protected enforcedFor() {
    const read = 'fs.read.workspace';
    if (this.sandboxMode === 'workspace-write') {
      return {
        capabilities: [read, 'fs.write.workspace', 'structured_output'],
        isolation: 'workspace-fs' as const,
        unconfined: false,
      };
    }
    return { capabilities: [read, 'structured_output'], isolation: 'workspace-fs' as const, unconfined: false };
  }

  protected buildDispatchArgs(): string[] {
    // Least-privilege default; `danger-full-access` is deliberately not offered.
    return ['exec', '-s', this.sandboxMode];
  }
}

/**
 * Claude Code. `-p` prints and exits; `--permission-prompts none` makes every
 * permission request auto-denied, so an unattended run can neither escalate
 * nor hang waiting for someone who is not there.
 */
export class ClaudeCodeAdapter extends BaseCliAdapter {
  readonly id = 'claude-code-adapter';
  readonly provider = 'claude-code';
  protected readonly binary = 'claude';
  protected readonly versionArgs = ['--version'];
  protected readonly authArgs = ['auth', 'status'];

  protected override loginHint(): string {
    return 'claude auth login';
  }

  protected enforcedFor() {
    return {
      capabilities: ['fs.read.workspace', 'fs.write.workspace', 'structured_output'],
      // Claude Code enforces its own permission layer, not an OS sandbox.
      // Reported honestly as workspace-fs, never inflated to `container`.
      isolation: 'workspace-fs' as const,
      unconfined: false,
    };
  }

  protected buildDispatchArgs(): string[] {
    return ['-p', '--permission-prompts', 'none'];
  }
}

/**
 * Gemini CLI (google/gemini-cli).
 *
 * `-p` selects headless mode and appends the prompt from STDIN, so the
 * untrusted objective never enters argv (same rule as the other adapters).
 * `--approval-mode plan` enforces a read-only contract (no file writes, no
 * command execution) - the default, which matches the enforced capability
 * declared for gemini in the fleet registry. A non-plan mode widens that to
 * `fs.write.workspace` and is opt-in via the constructor.
 *
 * Gemini has no non-hanging auth-status subcommand we can rely on across
 * versions, so auth is never probed; `probe()` reports AUTH_UNVERIFIED with
 * a vendor hint instead of guessing a command.
 */
export type GeminiApprovalMode = 'plan' | 'default' | 'auto-edit' | 'yolo';

export interface GeminiAdapterOptions extends CliAgentOptions {
  /** Defaults to 'plan' (read-only). Other modes grant fs.write.workspace. */
  approvalMode?: GeminiApprovalMode;
}

export class GeminiAdapter extends BaseCliAdapter {
  readonly id = 'gemini-adapter';
  readonly provider = 'gemini';
  protected readonly binary = 'gemini';
  protected readonly versionArgs = ['--version'];
  protected readonly authArgs = ['auth', 'status'];
  private readonly approvalMode: GeminiApprovalMode;

  constructor(opts: GeminiAdapterOptions = {}) {
    super(opts);
    this.approvalMode = opts.approvalMode ?? 'plan';
  }

  /** No reliable auth-status command; report unverified rather than guess. */
  protected override supportsAuthProbe = false;

  protected override loginHint(): string {
    return 'gemini auth login (verify your Gemini credentials before dispatching)';
  }

  protected enforcedFor() {
    const read = 'fs.read.workspace';
    const capabilities = this.approvalMode === 'plan'
      ? [read, 'structured_output']
      : [read, 'fs.write.workspace', 'structured_output'];
    return { capabilities, isolation: 'workspace-fs' as const, unconfined: false };
  }

  protected buildDispatchArgs(): string[] {
    // `-p` reads the objective from stdin; `--approval-mode plan` keeps it
    // read-only. No vendor "skip permissions" flag is passed.
    return ['-p', '--approval-mode', this.approvalMode];
  }
}

/**
 * Qwen Code CLI (qwen-code).
 *
 * A codex-family fork. `-p` selects headless mode and appends the prompt
 * from STDIN, so the untrusted objective never enters argv. `--approval-mode
 * plan` enforces read-only by default (matching the fleet registry's declared
 * enforced capability for qwen-code); other modes widen to fs.write.workspace
 * and are opt-in.
 *
 * qwen-code removed its `auth status` subcommand, so auth is never probed;
 * `probe()` reports AUTH_UNVERIFIED with a hint to verify the API key /
 * OAuth config out of band.
 */
export type QwenApprovalMode = 'plan' | 'default' | 'auto-edit' | 'auto' | 'yolo';

export interface QwenAdapterOptions extends CliAgentOptions {
  /** Defaults to 'plan' (read-only). Other modes grant fs.write.workspace. */
  approvalMode?: QwenApprovalMode;
}

export class QwenCodeAdapter extends BaseCliAdapter {
  readonly id = 'qwen-code-adapter';
  readonly provider = 'qwen-code';
  protected readonly binary = 'qwen';
  protected readonly versionArgs = ['--version'];
  protected readonly authArgs = ['auth', 'status'];
  private readonly approvalMode: QwenApprovalMode;

  constructor(opts: QwenAdapterOptions = {}) {
    super(opts);
    this.approvalMode = opts.approvalMode ?? 'plan';
  }

  /** qwen-code dropped `auth status`; report unverified rather than guess. */
  protected override supportsAuthProbe = false;

  protected override loginHint(): string {
    return 'qwen-code authenticates via its API key / OAuth config - verify with `qwen` interactively before dispatching';
  }

  protected enforcedFor() {
    const read = 'fs.read.workspace';
    const capabilities = this.approvalMode === 'plan'
      ? [read, 'structured_output']
      : [read, 'fs.write.workspace', 'structured_output'];
    return { capabilities, isolation: 'workspace-fs' as const, unconfined: false };
  }

  protected buildDispatchArgs(): string[] {
    // `-p` reads the objective from stdin (deprecated in favour of a
    // positional prompt, but the positional form would put untrusted text in
    // argv, so we keep `-p`). `--approval-mode plan` keeps it read-only.
    return ['-p', '--approval-mode', this.approvalMode];
  }
}
