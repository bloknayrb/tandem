import { describe, it, expect } from 'vitest';
import {
  headingPrefixLength,
  headingPrefix,
  FLAT_SEPARATOR,
} from '../../src/shared/offsets';

describe('headingPrefixLength', () => {
  it('returns 0 for null/undefined/0', () => {
    expect(headingPrefixLength(null)).toBe(0);
    expect(headingPrefixLength(undefined)).toBe(0);
    expect(headingPrefixLength(0)).toBe(0);
  });

  it('returns level + 1 for heading levels', () => {
    expect(headingPrefixLength(1)).toBe(2);  // "# "
    expect(headingPrefixLength(2)).toBe(3);  // "## "
    expect(headingPrefixLength(3)).toBe(4);  // "### "
    expect(headingPrefixLength(4)).toBe(5);  // "#### "
    expect(headingPrefixLength(6)).toBe(7);  // "###### "
  });
});

describe('headingPrefix', () => {
  it('builds correct prefix strings', () => {
    expect(headingPrefix(1)).toBe('# ');
    expect(headingPrefix(2)).toBe('## ');
    expect(headingPrefix(3)).toBe('### ');
  });
});

describe('FLAT_SEPARATOR', () => {
  it('is a newline', () => {
    expect(FLAT_SEPARATOR).toBe('\n');
  });
});
