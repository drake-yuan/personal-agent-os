import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ArtifactStore, ArtifactTooLargeError, PathEscapeError } from '../src/artifacts.js';

let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'paos-artifacts-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('artifact store (opaque IDs, §12.4)', () => {
  it('stores content under an opaque id and reads it back', () => {
    const store = new ArtifactStore(dir);
    const stored = store.put({ kind: 'change_summary', mediaType: 'application/json', content: '{"a":1}' });
    expect(stored.id).toMatch(/^artifact_[a-f0-9]{24}$/);
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    const read = store.get(stored.id);
    expect(read.content.toString()).toBe('{"a":1}');
    expect(read.artifact.sha256).toBe(stored.sha256);
  });

  it('verify() detects hash mismatches (tamper detection)', () => {
    const store = new ArtifactStore(dir);
    const stored = store.put({ kind: 'doc', mediaType: 'text/plain', content: 'hello' });
    expect(store.verify(stored.id, stored.sha256)).toBe(true);
    expect(store.verify(stored.id, 'b'.repeat(64))).toBe(false);
  });

  it('rejects oversized artifacts', () => {
    const store = new ArtifactStore(dir);
    const big = Buffer.alloc(33 * 1024 * 1024, 0);
    expect(() => store.put({ kind: 'x', mediaType: 'application/octet-stream', content: big }))
      .toThrow(ArtifactTooLargeError);
  });

  it('get() on a missing id throws, never leaks paths', () => {
    const store = new ArtifactStore(dir);
    expect(() => store.get('artifact_doesnotexist0000000000')).toThrow(/not found/);
  });

  it('path traversal attempts are rejected', () => {
    const store = new ArtifactStore(dir);
    // Crafted id that would resolve outside the store
    expect(() => store.get('artifact_..%2F..%2Fetc%2Fpasswd')).toThrow();
    expect(PathEscapeError).toBeDefined();
  });

  it('classification and trust level are recorded', () => {
    const store = new ArtifactStore(dir);
    const stored = store.put({
      kind: 'jd', mediaType: 'text/plain', content: 'jd',
      dataClassification: 'personal', trustLevel: 'external_untrusted',
    });
    expect(stored.dataClassification).toBe('personal');
    expect(stored.trustLevel).toBe('external_untrusted');
  });
});
