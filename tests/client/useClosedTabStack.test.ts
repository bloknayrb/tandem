import { describe, expect, it } from "vitest";
import { createClosedTabStack } from "../../src/client/hooks/useClosedTabStack.svelte.js";

const rec = (filePath: string, closedAt = Date.now()) => ({ filePath, closedAt });

describe("createClosedTabStack", () => {
  it("push then pop returns the most recent record", () => {
    const stack = createClosedTabStack();
    stack.push(rec("/a"));
    stack.push(rec("/b"));
    expect(stack.pop()?.filePath).toBe("/b");
    expect(stack.pop()?.filePath).toBe("/a");
  });

  it("pop on empty returns null", () => {
    const stack = createClosedTabStack();
    expect(stack.pop()).toBeNull();
  });

  it("peek returns the head without consuming", () => {
    const stack = createClosedTabStack();
    stack.push(rec("/a"));
    stack.push(rec("/b"));
    expect(stack.peek()?.filePath).toBe("/b");
    expect(stack.size()).toBe(2);
  });

  it("peek on empty returns null", () => {
    const stack = createClosedTabStack();
    expect(stack.peek()).toBeNull();
  });

  it("dedups consecutive duplicates at the head", () => {
    const stack = createClosedTabStack();
    stack.push(rec("/a"));
    stack.push(rec("/a"));
    stack.push(rec("/a"));
    expect(stack.size()).toBe(1);
  });

  it("non-consecutive duplicates are kept (close /a, /b, /a is three entries)", () => {
    const stack = createClosedTabStack();
    stack.push(rec("/a"));
    stack.push(rec("/b"));
    stack.push(rec("/a"));
    expect(stack.size()).toBe(3);
  });

  it("evicts oldest when cap is exceeded (FIFO eviction, LIFO pop)", () => {
    const stack = createClosedTabStack(3);
    stack.push(rec("/a"));
    stack.push(rec("/b"));
    stack.push(rec("/c"));
    stack.push(rec("/d"));
    expect(stack.size()).toBe(3);
    expect(stack.pop()?.filePath).toBe("/d");
    expect(stack.pop()?.filePath).toBe("/c");
    expect(stack.pop()?.filePath).toBe("/b");
    // /a was evicted to make room for /d
    expect(stack.pop()).toBeNull();
  });

  it("clear empties the stack", () => {
    const stack = createClosedTabStack();
    stack.push(rec("/a"));
    stack.push(rec("/b"));
    stack.clear();
    expect(stack.size()).toBe(0);
    expect(stack.pop()).toBeNull();
  });
});
