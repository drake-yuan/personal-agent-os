/**
 * Adapter registry + doctor five-level diagnostics (design Section 10.5, P2-07).
 *
 * Levels: installed -> authenticated -> capabilities (declared vs
 * enforced) -> enforced_isolation -> live_connectivity. `--version`
 * passing is NOT "can complete tasks".
 */
import type { AgentAdapter, AdapterHealth } from './types.js';

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  all(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Eligible adapters for a contract's required (enforced) capabilities.
   * `healthOf` supplies the latest probed health (probe results are
   * cached by the caller, never re-run per dispatch).
   */
  eligible(
    requiredCapabilities: string[],
    needsIsolation: boolean,
    healthOf: (adapter: AgentAdapter) => AdapterHealth,
  ): AgentAdapter[] {
    return this.all().filter((a) => {
      const h = healthOf(a);
      if (!h.installed || !h.authenticated || !h.liveConnectivity) return false;
      if (needsIsolation && (h.unconfined || h.enforcedIsolation === 'none')) return false;
      return requiredCapabilities.every((c) => h.enforcedCapabilities.includes(c));
    });
  }
}

export type DoctorLevel = 'installed' | 'authenticated' | 'capabilities' | 'enforced_isolation' | 'live_connectivity';

export interface DoctorRow {
  adapterId: string;
  level: DoctorLevel;
  ok: boolean;
  code?: string;   // e.g. E_AUTH_MISSING
  nextStep?: string;
}

/** Per-adapter login guidance. Guessed commands are worse than none. */
function loginHint(adapterId: string): string {
  if (adapterId.includes('claude')) return 'run `claude auth login`';
  if (adapterId.includes('codex')) return 'run `codex login`';
  if (adapterId.includes('gemini')) return 'run `gemini auth login`';
  return 'complete the vendor login for this adapter';
}

/** Run the five-level doctor for one adapter health snapshot. */
export function doctor(id: string, health: AdapterHealth): DoctorRow[] {
  const rows: DoctorRow[] = [
    {
      adapterId: id, level: 'installed', ok: health.installed,
      code: health.installed ? undefined : 'E_NOT_INSTALLED',
      nextStep: health.installed ? undefined : 'install the CLI and re-run doctor',
    },
    {
      adapterId: id, level: 'authenticated', ok: health.authenticated,
      code: health.authenticated ? undefined : health.diagnostics.find((d) => d.code.startsWith('AUTH'))?.code ?? 'E_AUTH_MISSING',
      nextStep: health.authenticated ? undefined : health.diagnostics.find((d) => d.code.startsWith('AUTH'))?.nextStep ?? loginHint(id),
    },
    {
      adapterId: id, level: 'capabilities',
      ok: health.enforcedCapabilities.length > 0,
      code: health.enforcedCapabilities.length > 0 ? undefined : 'E_NO_ENFORCED_CAPS',
      nextStep: health.enforcedCapabilities.length > 0 ? undefined : 'declared-only adapter; no hard capability decisions possible',
    },
    {
      adapterId: id, level: 'enforced_isolation',
      ok: health.enforcedIsolation !== 'none',
      code: health.enforcedIsolation !== 'none' ? undefined : 'E_UNCONFINED',
      nextStep: health.enforcedIsolation !== 'none' ? undefined : 'no OS-level isolation; scope-restricted work refused',
    },
    {
      adapterId: id, level: 'live_connectivity', ok: health.liveConnectivity,
      code: health.liveConnectivity ? undefined : 'E_OFFLINE',
      nextStep: health.liveConnectivity ? undefined : 'check network; adapter stays paused, no retry storm',
    },
  ];
  return rows;
}
