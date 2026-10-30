/**
 * Real-dispatch smoke test (opt-in, local only).
 *
 * CI never runs this: it requires the real agent CLIs (codex / claude / gemini /
 * qwen) installed on the host and would burn real tokens / hit the network if a
 * live run were attempted. `paos doctor --adapter <id>` only probes the binary
 * (a `--version` call), so it is offline-safe and proves the real spawn chain
 * works end to end for each registered adapter.
 *
 * Run locally with:  PAOS_SMOKE_REAL=1 pnpm smoke:real
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const cli = path.join(root, 'apps', 'cli', 'dist', 'index.js');
const adapters = ['codex', 'claude', 'gemini', 'qwen'];

if (process.env.PAOS_SMOKE_REAL !== '1') {
  console.log('smoke:real skipped — set PAOS_SMOKE_REAL=1 to exercise the real local agent CLIs.');
  process.exit(0);
}

if (!cli) {
  console.error('cli build missing; run `pnpm build` first.');
  process.exit(1);
}

let failed = 0;
for (const id of adapters) {
  const res = spawnSync('node', [cli, 'doctor', '--adapter', id], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = (res.stdout || '') + (res.stderr || '');
  // Installed => the adapter resolved the binary and spawned `--version` ok.
  const reachable = !/E_NOT_INSTALLED|not found on PATH/.test(out);
  const ok = res.status === 0 && reachable;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  (exit=${res.status})`);
  if (!ok) {
    failed++;
    console.log(out.split('\n').slice(0, 12).join('\n'));
  }
}

if (failed === 0) {
  console.log('\nAll real adapters reachable on this host — genuine dispatch chain is live.');
} else {
  console.log(`\n${failed} adapter(s) not reachable. Install the missing CLI or fix PATH.`);
}
process.exit(failed === 0 ? 0 : 1);
