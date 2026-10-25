/**
 * Demo adapter - the zero-secret fixture executor (design §19.3).
 *
 * It exists so the first-run experience needs no API keys: contracts
 * are executed against recorded fixtures under demo/fixtures/. It is
 * also the adapter used by the deterministic eval gates. It NEVER
 * touches the network and NEVER claims task completion - it returns
 * observations like any real adapter.
 */
import type {
  AgentAdapter, AdapterHealth, DispatchOutcome, RunEvent, CancelOutcome,
  ProviderObservation, VendorRaw, DispatchPlan,
} from './types.js';
import type { DispatchIntent } from '@paos/runtime';

export interface DemoFixture {
  providerTaskId: string;
  providerStatus: string;
  exitCode: number;
  artifacts: Array<{ artifact_id: string; kind: string; sha256: string; media_type: string; bytes: number }>;
}

export class DemoAdapter implements AgentAdapter {
  readonly id = 'demo-adapter';
  readonly provider = 'demo';
  readonly fixtures: Map<string, DemoFixture>;
  /** When set, the next dispatch simulates this transport failure. */
  public nextTransportFailure: DispatchOutcome['transport'] | undefined;

  constructor(fixtures: DemoFixture[] = []) {
    this.fixtures = new Map(fixtures.map((f) => [f.providerTaskId, f]));
  }

  async probe(): Promise<AdapterHealth> {
    return {
      installed: true,
      authenticated: true,
      declaredCapabilities: ['fs.read.workspace', 'fs.write.workspace'],
      enforcedCapabilities: ['fs.read.workspace', 'fs.write.workspace'],
      enforcedIsolation: 'workspace-fs',
      unconfined: false,
      liveConnectivity: true,
      maxSilentMs: 1000,
      supportsServerIdempotency: true, // fixtures make retry deterministic
      diagnostics: [],
    };
  }

  async plan(input: { contract: unknown; workspace: string }): Promise<DispatchPlan> {
    const contract = input.contract as { objective?: string };
    return {
      provider: 'demo',
      command: ['paos-demo', 'exec', contract.objective ?? ''],
      cwd: input.workspace,
      env: {},
      estimatedMaxSilentMs: 1000,
    };
  }

  async dispatch(intent: DispatchIntent, _ctx: { plan: DispatchPlan }): Promise<DispatchOutcome> {
    if (this.nextTransportFailure) {
      const failure = this.nextTransportFailure;
      this.nextTransportFailure = undefined;
      return { transport: failure, error: `simulated ${failure}` };
    }
    const fixture = this.fixtures.get(intent.idempotencyKey) ?? this.fixtures.values().next().value;
    if (!fixture) {
      return { transport: 'protocol_error', error: 'no fixture for dispatch' };
    }
    return { transport: 'ok', providerTaskId: fixture.providerTaskId };
  }

  async *stream(runId: string): AsyncIterable<RunEvent> {
    yield { at: new Date().toISOString(), eventType: 'demo.progress', detail: `fixture run ${runId}` };
  }

  async cancel(_runId: string): Promise<CancelOutcome> {
    return { local: 'stopped', remote: 'confirmed' };
  }

  async reconcile(providerTaskId: string): Promise<ProviderObservation> {
    const fixture = [...this.fixtures.values()].find((f) => f.providerTaskId === providerTaskId);
    return {
      providerTaskId,
      providerStatus: fixture?.providerStatus ?? 'unknown',
      transport: 'ok',
    };
  }

  mapResult(raw: VendorRaw): unknown {
    // Observation contract only - the Runtime derives accepted/rejected.
    return {
      result_version: '1.1',
      provider: raw.provider,
      provider_status: raw.exitCode === 0 ? 'completed' : 'failed',
      transport_status: 'ok',
      native_run: { run_id: raw.provider, exit_code: raw.exitCode ?? 0 },
      raw_result_ref: `demo-raw-${raw.provider}`,
      artifacts: [],
      usage: { duration_s: null, tokens: null, cost_usd: null, cost_source: 'unknown' },
      errors: [],
    };
  }
}
