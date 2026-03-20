import { describe, it, expect } from 'vitest';
import { mcpSuccess, mcpError, noDocumentError, getErrorMessage, escapeRegex } from '../../src/server/mcp/response.js';

const parse = (r: any) => JSON.parse(r.content[0].text);

describe('mcpSuccess', () => {
  it('wraps data in expected content structure', () => {
    const result = mcpSuccess({ foo: 'bar' });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = parse(result);
    expect(parsed).toEqual({ error: false, data: { foo: 'bar' } });
  });

  it('handles complex nested objects', () => {
    const data = { a: { b: { c: [1, 2, 3] } }, d: true };
    const parsed = parse(mcpSuccess(data));
    expect(parsed.error).toBe(false);
    expect(parsed.data).toEqual(data);
  });

  it('handles null data', () => {
    const parsed = parse(mcpSuccess(null));
    expect(parsed).toEqual({ error: false, data: null });
  });

  it('handles undefined data', () => {
    const parsed = parse(mcpSuccess(undefined));
    expect(parsed.error).toBe(false);
  });
});

describe('mcpError', () => {
  it('includes code and message with error: true', () => {
    const parsed = parse(mcpError('SOME_CODE', 'something went wrong'));
    expect(parsed).toEqual({ error: true, code: 'SOME_CODE', message: 'something went wrong' });
  });

  it('includes details when provided', () => {
    const parsed = parse(mcpError('ERR', 'msg', { offset: 42, context: 'test' }));
    expect(parsed.error).toBe(true);
    expect(parsed.details).toEqual({ offset: 42, context: 'test' });
  });

  it('omits details key when not provided', () => {
    const parsed = parse(mcpError('ERR', 'msg'));
    expect('details' in parsed).toBe(false);
  });
});

describe('noDocumentError', () => {
  it('uses NO_DOCUMENT code', () => {
    const parsed = parse(noDocumentError());
    expect(parsed.code).toBe('NO_DOCUMENT');
  });

  it('message mentions tandem_open', () => {
    const parsed = parse(noDocumentError());
    expect(parsed.message).toContain('tandem_open');
  });

  it('has error: true', () => {
    const parsed = parse(noDocumentError());
    expect(parsed.error).toBe(true);
  });
});

describe('getErrorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies plain strings', () => {
    expect(getErrorMessage('raw string')).toBe('raw string');
  });

  it('stringifies numbers', () => {
    expect(getErrorMessage(404)).toBe('404');
  });

  it('stringifies objects', () => {
    expect(getErrorMessage({ code: 1 })).toBe('[object Object]');
  });

  it('stringifies null', () => {
    expect(getErrorMessage(null)).toBe('null');
  });
});

describe('escapeRegex', () => {
  it('escapes all regex metacharacters', () => {
    const meta = '.*+?^${}()|[]\\';
    const escaped = escapeRegex(meta);
    expect(() => new RegExp(escaped)).not.toThrow();
    expect(escaped).toContain('\\.');
    expect(escaped).toContain('\\*');
    expect(escaped).toContain('\\+');
    expect(escaped).toContain('\\?');
    expect(escaped).toContain('\\^');
    expect(escaped).toContain('\\$');
    expect(escaped).toContain('\\(');
    expect(escaped).toContain('\\)');
    expect(escaped).toContain('\\|');
    expect(escaped).toContain('\\[');
    expect(escaped).toContain('\\\\');
  });

  it('leaves alphanumeric and whitespace untouched', () => {
    expect(escapeRegex('Hello World 123')).toBe('Hello World 123');
  });

  it('handles empty string', () => {
    expect(escapeRegex('')).toBe('');
  });

  it('handles string that is entirely metacharacters', () => {
    const all = '.*+?^${}()|[]\\';
    const escaped = escapeRegex(all);
    expect(() => new RegExp(escaped)).not.toThrow();
    expect(escaped.length).toBeGreaterThan(all.length);
  });
});
