/**
 * paos:// schema store.
 *
 * Canonical schemas live at the repository root `schemas/` directory
 * (design Section 18.1). A paos:// id resolves to `schemas/<name>-<semver>.json`.
 * Remote URLs are never fetched (SSRF / dependency-pollution defence).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCHEMA_ID_PATTERN } from './enums.js';

export const SCHEMA_ROOT_NOT_FOUND = 'schema root not found';

export interface LoadedSchema {
  id: string;
  schema: unknown;
}

/** Locate the repo-root schemas/ dir by walking up from this module. */
function findSchemaRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'schemas');
    try {
      readFileSync(path.join(candidate, 'agent-task-contract-1.1.0.json'), 'utf8');
      return candidate;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error(SCHEMA_ROOT_NOT_FOUND);
}

export function schemaPathFor(id: string): string {
  if (!SCHEMA_ID_PATTERN.test(id)) {
    throw new Error(`invalid paos:// schema id: ${id}`);
  }
  const withoutScheme = id.slice('paos://'.length); // schemas/<name>/<semver>
  const [, name, semver] = withoutScheme.split('/');
  return path.join(findSchemaRoot(), `${name}-${semver}.json`);
}

export function loadSchemaById(id: string): LoadedSchema {
  const raw = readFileSync(schemaPathFor(id), 'utf8');
  return { id, schema: JSON.parse(raw) as unknown };
}

/** Load by (name, semver) pair, e.g. ('agent-task-contract', '1.1.0'). */
export function loadSchema(name: string, semver: string): LoadedSchema {
  return loadSchemaById(`paos://schemas/${name}/${semver}`);
}
