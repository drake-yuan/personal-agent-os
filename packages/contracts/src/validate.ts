/**
 * Minimal deterministic JSON Schema (2020-12 subset) validator.
 *
 * PAOS validates every contract, manifest and artifact against a fixed
 * in-repo schema. The subset below is deliberately small and total: no
 * network $ref, no remote schema downloads (SSRF defence, design Section 12.4),
 * no regex backreferences. Fail-closed: anything the subset does not
 * understand is reported as an error, never silently accepted.
 */
import { SCHEMA_ID_PATTERN } from './enums.js';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const KNOWN_KEYWORDS = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'enum', 'const',
  'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'items', 'minItems', 'maxItems', 'anyOf', 'oneOf', 'allOf',
  'not', '$ref', '$defs', 'title', 'description', 'default', 'examples', 'format',
  'uniqueItems', 'multipleOf', 'nullable',
  // meta keywords (annotations, never constraints)
  '$schema', '$id', '$comment', 'deprecated', 'readOnly', 'writeOnly',
]);

export function validate(value: Json, schema: Json, path = '$'): ValidationResult {
  const errors: ValidationError[] = [];
  walk(value, schema, path, errors);
  return { ok: errors.length === 0, errors };
}

function walk(value: Json, schema: Json, path: string, errors: ValidationError[]): void {
  if (schema === true || schema === null) return;
  if (schema === false) {
    errors.push({ path, message: 'schema false: nothing valid' });
    return;
  }
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push({ path, message: 'invalid schema node' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      errors.push({ path, message: `unknown schema keyword "${key}" (fail-closed)` });
    }
  }

  if (schema.nullable === true && value === null) return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t as string))) {
      errors.push({ path, message: `expected type ${types.join('|')}, got ${typeOf(value)}` });
      return; // type mismatch: deeper checks are meaningless
    }
  }

  if (schema.enum !== undefined) {
    const allowed = schema.enum as Json[];
    if (!allowed.some((a) => deepEqual(a, value))) {
      errors.push({ path, message: `value not in enum [${allowed.map((a) => JSON.stringify(a)).join(', ')}]` });
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const as Json, value)) {
    errors.push({ path, message: `value !== const ${JSON.stringify(schema.const)}` });
  }

  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `string does not match pattern ${schema.pattern}` });
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, message: `string shorter than minLength ${schema.minLength}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, message: `string longer than maxLength ${schema.maxLength}` });
    }
    if (schema.format === 'schema-id' && !SCHEMA_ID_PATTERN.test(value)) {
      errors.push({ path, message: `not a valid paos:// schema id: ${value}` });
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, message: `number < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, message: `number > maximum ${schema.maximum}` });
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push({ path, message: `number <= exclusiveMinimum ${schema.exclusiveMinimum}` });
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      errors.push({ path, message: `number >= exclusiveMaximum ${schema.exclusiveMaximum}` });
    }
    if (typeof schema.multipleOf === 'number' && value % schema.multipleOf !== 0) {
      errors.push({ path, message: `not a multiple of ${schema.multipleOf}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push({ path, message: `array shorter than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push({ path, message: `array longer than maxItems ${schema.maxItems}` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push({ path, message: 'array items not unique' });
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => walk(item, schema.items as Json, `${path}[${i}]`, errors));
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, Json>;
    if (Array.isArray(schema.required)) {
      for (const req of schema.required as string[]) {
        if (!(req in obj)) errors.push({ path, message: `missing required property "${req}"` });
      }
    }
    const props = (schema.properties ?? {}) as Record<string, Json>;
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) walk(obj[k] as Json, sub, `${path}.${k}`, errors);
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errors.push({ path, message: `additional property "${k}" not allowed` });
      }
    } else if (additional !== undefined && additional !== true) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) walk(obj[k] as Json, additional as Json, `${path}.${k}`, errors);
      }
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Json[]) walk(value, sub, path, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const anyOf = schema.anyOf as Json[];
    const local: ValidationError[] = [];
    for (const sub of anyOf) {
      const before = local.length;
      walk(value, sub, path, local);
      if (local.length === before) return; // one branch passed
      local.length = before;
    }
    errors.push({ path, message: 'value matches none of anyOf branches' });
  }
  if (Array.isArray(schema.oneOf)) {
    const oneOf = schema.oneOf as Json[];
    let matches = 0;
    for (const sub of oneOf) {
      const local: ValidationError[] = [];
      walk(value, sub, path, local);
      if (local.length === 0) matches += 1;
    }
    if (matches !== 1) errors.push({ path, message: `value matches ${matches} oneOf branches, expected exactly 1` });
  }
  if (schema.not !== undefined) {
    const local: ValidationError[] = [];
    walk(value, schema.not as Json, path, local);
    if (local.length === 0) errors.push({ path, message: 'value matches "not" schema' });
  }
}

function typeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object'
}

/** JSON Schema type match, including the integer specialisation of number. */
function matchesType(value: Json, type: string): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOf(value) === type;
}

function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
