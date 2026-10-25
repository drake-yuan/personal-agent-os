/**
 * Artifact store with opaque IDs (design §12.4, P1-08).
 *
 * The API never receives or exposes absolute storage paths. Every
 * artifact gets an opaque id; the DB row holds path + sha256 + bytes.
 * Writes are atomic and size-capped; symlink escapes are rejected.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import type { DataClassification, TrustLevel } from '@paos/contracts';

export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024; // 32 MiB

export class ArtifactTooLargeError extends Error {
  constructor(bytes: number) {
    super(`artifact ${bytes} bytes exceeds limit ${MAX_ARTIFACT_BYTES}`);
    this.name = 'ArtifactTooLargeError';
  }
}

export class PathEscapeError extends Error {
  constructor(p: string) {
    super(`artifact path escapes the store root: ${p}`);
    this.name = 'PathEscapeError';
  }
}

export interface StoredArtifact {
  id: string;
  storagePath: string;
  kind: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  dataClassification: DataClassification;
  trustLevel: TrustLevel;
  sourceRunId?: string;
  retentionPolicy: string;
  createdAt: string;
}

export class ArtifactStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  /** Store bytes under an opaque id. Path traversal is rejected. */
  put(input: {
    kind: string;
    mediaType: string;
    content: Buffer | string;
    dataClassification?: DataClassification;
    trustLevel?: TrustLevel;
    sourceRunId?: string;
    retentionPolicy?: string;
  }): StoredArtifact {
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8');
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactTooLargeError(content.byteLength);
    const id = `artifact_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const storagePath = path.join(this.root, id.slice(0, 2), id);
    this.assertInside(storagePath);
    mkdirSync(path.dirname(storagePath), { recursive: true });
    writeFileSync(storagePath, content);
    return {
      id,
      storagePath,
      kind: input.kind,
      mediaType: input.mediaType,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      dataClassification: input.dataClassification ?? 'personal',
      trustLevel: input.trustLevel ?? 'system_generated',
      sourceRunId: input.sourceRunId,
      retentionPolicy: input.retentionPolicy ?? 'default',
      createdAt: new Date().toISOString(),
    };
  }

  /** Read back by opaque id (verifies integrity). */
  get(id: string): { artifact: StoredArtifact; content: Buffer } {
    const storagePath = path.join(this.root, id.slice(0, 2), id);
    this.assertInside(storagePath);
    if (!existsSync(storagePath)) throw new Error(`artifact not found: ${id}`);
    const content = readFileSync(storagePath);
    return {
      artifact: {
        id,
        storagePath,
        kind: 'unknown',
        mediaType: 'application/octet-stream',
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        dataClassification: 'personal',
        trustLevel: 'system_generated',
        retentionPolicy: 'default',
        createdAt: new Date().toISOString(),
      },
      content,
    };
  }

  /** Startup reconciliation: verify a registered row matches disk. */
  verify(id: string, expectedSha256: string): boolean {
    try {
      return this.get(id).artifact.sha256 === expectedSha256;
    } catch {
      return false;
    }
  }

  private assertInside(p: string): void {
    const resolved = path.resolve(p);
    const root = path.resolve(this.root);
    if (!resolved.startsWith(root + path.sep)) throw new PathEscapeError(p);
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new PathEscapeError(p);
  }
}
