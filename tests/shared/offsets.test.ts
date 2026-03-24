import { describe, it, expect } from 'vitest';
import {
  headingPrefixLength,
  headingPrefix,
  FLAT_SEPARATOR,
  walkFlatOffsets,
} from '../../src/shared/offsets';
import type { NodeInfo } from '../../src/shared/offsets';

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

describe('walkFlatOffsets', () => {
  const nodes: NodeInfo[] = [
    { headingLevel: 2, textLength: 5 },    // "## Title" → prefix 3, text 5 = 8 chars
    { headingLevel: null, textLength: 10 }, // "Some text." → prefix 0, text 10 = 10 chars
    { headingLevel: null, textLength: 3 },  // "End" → prefix 0, text 3 = 3 chars
  ];

  it('visits each node with correct accumulated offset', () => {
    const visited: Array<{ index: number; accumulated: number; prefixLen: number }> = [];

    walkFlatOffsets(
      nodes.length,
      (i) => nodes[i],
      (index, _node, accumulated, prefixLen) => {
        visited.push({ index, accumulated, prefixLen });
        return undefined; // continue visiting
      },
    );

    // Node 0: accumulated=0, prefix=3 (heading level 2)
    expect(visited[0]).toEqual({ index: 0, accumulated: 0, prefixLen: 3 });
    // Node 1: accumulated = 3+5 (node 0) + 1 (separator) = 9
    expect(visited[1]).toEqual({ index: 1, accumulated: 9, prefixLen: 0 });
    // Node 2: accumulated = 9 + 10 (node 1) + 1 (separator) = 20
    expect(visited[2]).toEqual({ index: 2, accumulated: 20, prefixLen: 0 });
  });

  it('stops early when visitor returns a value', () => {
    const result = walkFlatOffsets(
      nodes.length,
      (i) => nodes[i],
      (index) => {
        if (index === 1) return 'found';
        return undefined;
      },
    );

    expect(result).toBe('found');
  });

  it('returns undefined when no visitor returns a value', () => {
    const result = walkFlatOffsets(
      nodes.length,
      (i) => nodes[i],
      () => undefined,
    );

    expect(result).toBeUndefined();
  });

  it('handles empty document', () => {
    const visited: number[] = [];
    walkFlatOffsets(0, () => ({ headingLevel: null, textLength: 0 }), (i) => {
      visited.push(i);
      return undefined;
    });
    expect(visited).toEqual([]);
  });

  it('handles single node (no separator)', () => {
    const singleNode: NodeInfo[] = [{ headingLevel: null, textLength: 5 }];
    const offsets: number[] = [];

    walkFlatOffsets(1, (i) => singleNode[i], (_i, _n, acc) => {
      offsets.push(acc);
      return undefined;
    });

    expect(offsets).toEqual([0]);
  });
});
