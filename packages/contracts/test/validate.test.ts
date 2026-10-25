import { describe, expect, it } from 'vitest';
import { validate } from '../src/validate.js';

describe('JSON Schema subset validator', () => {
  it('accepts valid objects and rejects missing required', () => {
    const schema = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    expect(validate({ a: 'x' }, schema).ok).toBe(true);
    expect(validate({}, schema).ok).toBe(false);
    expect(validate({ a: 1 }, schema).ok).toBe(false);
    expect(validate({ a: 'x', b: 1 }, schema).ok).toBe(false); // additionalProperties:false
  });

  it('enforces enum and const', () => {
    expect(validate('R3', { enum: ['R0', 'R3'] }).ok).toBe(true);
    expect(validate('R9', { enum: ['R0', 'R3'] }).ok).toBe(false);
    expect(validate('1.1', { const: '1.1' }).ok).toBe(true);
    expect(validate('1.0', { const: '1.1' }).ok).toBe(false);
  });

  it('enforces string constraints', () => {
    expect(validate('abc', { type: 'string', minLength: 2, maxLength: 3 }).ok).toBe(true);
    expect(validate('a', { type: 'string', minLength: 2 }).ok).toBe(false);
    expect(validate('abcd', { type: 'string', maxLength: 3 }).ok).toBe(false);
    expect(validate('abc', { type: 'string', pattern: '^a' }).ok).toBe(true);
    expect(validate('xbc', { type: 'string', pattern: '^a' }).ok).toBe(false);
  });

  it('enforces numeric bounds', () => {
    expect(validate(5, { type: 'number', minimum: 1, maximum: 10 }).ok).toBe(true);
    expect(validate(0, { type: 'number', minimum: 1 }).ok).toBe(false);
    expect(validate(11, { type: 'number', maximum: 10 }).ok).toBe(false);
    expect(validate(4, { type: 'integer', multipleOf: 2 }).ok).toBe(true);
    expect(validate(5, { type: 'integer', multipleOf: 2 }).ok).toBe(false);
  });

  it('enforces array constraints', () => {
    expect(validate([1, 2], { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 3 }).ok).toBe(true);
    expect(validate([], { type: 'array', minItems: 1 }).ok).toBe(false);
    expect(validate([1, 'x'], { type: 'array', items: { type: 'number' } }).ok).toBe(false);
    expect(validate([1, 1], { type: 'array', uniqueItems: true }).ok).toBe(false);
  });

  it('supports anyOf / oneOf / not / allOf', () => {
    expect(validate(null, { anyOf: [{ type: 'null' }, { type: 'string' }] }).ok).toBe(true);
    expect(validate(5, { anyOf: [{ type: 'null' }, { type: 'string' }] }).ok).toBe(false);
    expect(validate({ a: 1 }, { oneOf: [{ required: ['a'] }, { required: ['b'] }] }).ok).toBe(true);
    expect(validate({ a: 1, b: 2 }, { oneOf: [{ required: ['a'] }, { required: ['b'] }] }).ok).toBe(false);
    expect(validate('x', { not: { type: 'number' } }).ok).toBe(true);
    expect(validate(1, { not: { type: 'number' } }).ok).toBe(false);
  });

  it('validates the paos:// schema-id format', () => {
    const fmt = { type: 'string', format: 'schema-id' };
    expect(validate('paos://schemas/change-summary/1.0.0', fmt).ok).toBe(true);
    expect(validate('https://evil.example/schema.json', fmt).ok).toBe(false);
    expect(validate('paos://schemas/Change_Summary/1.0', fmt).ok).toBe(false);
  });

  it('fail-closed on unknown schema keywords', () => {
    expect(validate({}, { type: 'object', xWeirdKeyword: true }).ok).toBe(false);
  });

  it('reports the failing path', () => {
    const result = validate({ a: { b: 1 } }, {
      type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.path).toBe('$.a.b');
  });
});
