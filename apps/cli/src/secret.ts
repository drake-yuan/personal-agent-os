/**
 * installation.secret loader + constant-time bearer-token verification for the
 * cockpit service (Alt.1 P0 auth baseline).
 *
 * The secret is minted once by `paos init` (32 random bytes, base64url) and
 * stored at <dataDir>/installation.secret with mode 0600. It is the single
 * shared bearer token between the CLI (which knows where the file lives) and the
 * local-only HTTP service (bound to 127.0.0.1). The HTTP layer never receives
 * the file path; it only ever compares a presented token against this value.
 */
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const INSTALLATION_SECRET_FILE = 'installation.secret';

/** Read the raw secret from <dataDir>/installation.secret. Throws if absent. */
export function loadInstallationSecret(dataDir: string): string {
  const file = path.join(dataDir, INSTALLATION_SECRET_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `no installation.secret in ${dataDir} - run \`paos init\` first to generate the cockpit token`,
    );
  }
  return readFileSync(file, 'utf8').trim();
}

/**
 * Constant-time comparison of a presented bearer token against the expected
 * secret. Returns false on missing/undefined input; a length mismatch still runs
 * a dummy comparison so the timing does not short-circuit on length alone.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
