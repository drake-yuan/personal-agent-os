/**
 * Subprocess execution for CLI-backed adapters (design Section 10.1).
 *
 * Three rules this module enforces:
 *  1. NEVER `shell: true`. Arguments are always passed as an argv array, so
 *     no user-controlled string can become shell syntax. Untrusted text
 *     (the contract objective) is delivered over stdin, not argv.
 *  2. Output is capped. A runaway transcript must not OOM the OS process.
 *  3. A timeout is reported, not swallowed - the caller maps it to
 *     `unknown_outcome` (Section 7.2: a timeout is never a silent failure).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Cap per-stream capture; the remainder is truncated, not buffered forever. */
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export interface ExecRequest {
  /** Absolute path (or PATH-resolvable name) of the executable. */
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Delivered on stdin - keeps untrusted text out of argv. */
  stdin?: string;
  timeoutMs: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** Node spawn error code (e.g. ENOENT) - distinct from a non-zero exit. */
  error?: string;
}

export type ExecFn = (req: ExecRequest) => Promise<ExecResult>;

/**
 * Quote one argument for `cmd.exe /d /s /c`.
 *
 * Only needed on Windows when the target is a `.cmd`/`.bat` shim (npm
 * installs those for every global CLI); Node cannot spawn them directly.
 * Production argv contains no user text, but the escaping is kept correct
 * rather than assumed, because that is exactly how injection gets in later.
 */
export function quoteCmdArg(arg: string): string {
  if (arg.length > 0 && !/[\s"^&<>|%()!]/.test(arg)) return arg;
  // Double the backslashes that precede a quote so the quote stays literal.
  let escaped = arg.replace(/(\\*)"/g, (_m, backslashes: string) => `${backslashes}${backslashes}\\"`);
  // Trailing backslashes would escape our closing quote.
  escaped = escaped.replace(/(\\+)$/, (_m, backslashes: string) => `${backslashes}${backslashes}`);
  escaped = escaped.replace(/[%^&<>|()!]/g, (m) => `^${m}`);
  return `"${escaped}"`;
}

/** Windows needs a cmd.exe wrapper for .cmd/.bat shims; POSIX needs nothing. */
export function spawnTarget(
  executable: string,
  args: string[],
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== 'win32') return { file: executable, args };
  const ext = path.extname(executable).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file: executable, args };
  const command = [quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(' ');
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', command],
    windowsVerbatimArguments: true,
  };
}

const PATH_EXT = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .filter((e) => e.startsWith('.'));

/**
 * Resolve a binary name to a concrete file. On Windows, npm installs both
 * an extension-less shim (unusable from Node) and a `.cmd`; prefer the form
 * Node can actually spawn.
 */
export function resolveExecutable(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (binary.includes('/') || binary.includes('\\')) {
    return existsSync(binary) ? binary : undefined;
  }
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const candidates: string[] = [];
  for (const ext of PATH_EXT) candidates.push(`${binary}${ext.toLowerCase()}`);
  candidates.push(binary);
  for (const dir of dirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Environment allowlist: an adapter never inherits the whole parent env. */
export const DEFAULT_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'TERM', 'LANG', 'NO_COLOR', 'CI',
] as const;

export function filterEnv(
  allowlist: readonly string[],
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...extra };
}

export function defaultExec(req: ExecRequest): Promise<ExecResult> {
  const target = spawnTarget(req.executable, req.args);
  return new Promise((resolve) => {
    const child = spawn(target.file, target.args, {
      cwd: req.cwd,
      env: req.env ?? {},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let truncated = false;
    let timedOut = false;

    // Buffer up to the cap, then keep counting: a runaway transcript must
    // not grow this process without bound, but truncation must be reported.
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_CAPTURE_BYTES) { truncated = true; return; }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_CAPTURE_BYTES) { truncated = true; return; }
      err.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, req.timeoutMs);

    let settled = false;
    const finish = (result: { exitCode?: number | null; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated,
        timedOut,
        exitCode: result.exitCode ?? null,
        error: result.error,
      });
    };

    child.on('error', (e) => finish({ exitCode: null, error: (e as NodeJS.ErrnoException).code ?? e.message }));
    child.on('close', (code) => finish({ exitCode: code }));

    if (req.stdin === undefined) child.stdin?.end();
    else child.stdin?.end(req.stdin);
  });
}
