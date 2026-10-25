import { describe, expect, it } from 'vitest';
import { FLEET, findExecutor, executorCanEnforce, canAcceptContract } from '../src/fleet.js';

describe('fleet registry: declared vs enforced', () => {
  it('finds installed executors', () => {
    expect(findExecutor('codex')?.version).toBe('0.157.1');
    expect(findExecutor('nope')).toBeUndefined();
  });

  it('only enforced capabilities gate hard decisions', () => {
    const codex = findExecutor('codex')!;
    expect(executorCanEnforce(codex, 'fs.write.workspace')).toBe(true);
    expect(executorCanEnforce(codex, 'external.send')).toBe(false);
  });

  it('unconfined adapters cannot take scope-restricted work', () => {
    const claude = findExecutor('claude-code')!;
    expect(claude.unconfined).toBe(true);
    expect(canAcceptContract(claude, ['fs.read.workspace'], false)).toBe(true);
    expect(canAcceptContract(claude, ['fs.read.workspace'], true)).toBe(false);
  });

  it('codex (workspace-fs) can take isolated work', () => {
    const codex = findExecutor('codex')!;
    expect(canAcceptContract(codex, ['fs.read.workspace', 'fs.write.workspace'], true)).toBe(true);
    expect(canAcceptContract(codex, ['external.send'], false)).toBe(false);
  });

  it('human covers everything', () => {
    const human = findExecutor('human')!;
    expect(executorCanEnforce(human, 'anything')).toBe(true);
    expect(canAcceptContract(human, ['external.send'], true)).toBe(true);
  });
});
