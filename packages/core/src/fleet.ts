/**
 * Fleet registry (design §5, §12.2).
 *
 * Executors are replaceable resources. Only ENFORCED capabilities may
 * gate hard security decisions; declared capabilities are advertising.
 * An executor that cannot enforce isolation is `unconfined` and must
 * not receive scope-restricted contracts.
 */
import type { Executor } from './types.js';

export const FLEET: Executor[] = [
  {
    id: 'workbuddy', kind: 'workbuddy',
    declaredCapabilities: ['fs.read.workspace', 'fs.write.workspace', 'process.exec', 'external.send'],
    enforcedCapabilities: [], unconfined: true, enforcedIsolation: 'none',
  },
  {
    id: 'claude-code', kind: 'claude-code', version: '2.1.283',
    declaredCapabilities: ['fs.read.workspace', 'fs.write.workspace', 'process.exec'],
    enforcedCapabilities: ['fs.read.workspace', 'process.exec'],
    unconfined: true, enforcedIsolation: 'none',
  },
  {
    id: 'codex', kind: 'codex', version: '0.157.1',
    declaredCapabilities: ['fs.read.workspace', 'fs.write.workspace', 'process.exec'],
    enforcedCapabilities: ['fs.read.workspace', 'fs.write.workspace'],
    unconfined: false, enforcedIsolation: 'workspace-fs',
  },
  {
    id: 'gemini', kind: 'gemini', version: '0.61.0',
    declaredCapabilities: ['fs.read.workspace', 'fs.write.workspace', 'network.egress.allowed_hosts'],
    enforcedCapabilities: ['fs.read.workspace'],
    unconfined: true, enforcedIsolation: 'none',
  },
  {
    id: 'qwen-code', kind: 'qwen-code', version: '0.24.6',
    declaredCapabilities: ['fs.read.workspace', 'process.exec'],
    enforcedCapabilities: ['fs.read.workspace'],
    unconfined: true, enforcedIsolation: 'none',
  },
  {
    id: 'human', kind: 'human',
    declaredCapabilities: ['*'], enforcedCapabilities: ['*'],
    unconfined: false, enforcedIsolation: 'none', trusted: true,
  },
];

export function findExecutor(id: string): Executor | undefined {
  return FLEET.find((e) => e.id === id);
}

/** Enforced capability check - the only kind used for hard decisions. */
export function executorCanEnforce(executor: Executor, capability: string): boolean {
  return executor.enforcedCapabilities.includes('*') || executor.enforcedCapabilities.includes(capability);
}

/** Router eligibility: enforced capabilities must cover the contract. */
export function canAcceptContract(executor: Executor, required: string[], needsIsolation: boolean): boolean {
  if (executor.trusted) return true; // the human user is the trust anchor
  if (needsIsolation && (executor.unconfined || executor.enforcedIsolation === 'none')) return false;
  return required.every((c) => executorCanEnforce(executor, c));
}
