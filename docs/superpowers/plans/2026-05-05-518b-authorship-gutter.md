# #518B — Authorship Gutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 2px colored left-margin thread to each paragraph and heading indicating whether the dominant author is `user` (blue) or `claude` (orange).

**Architecture:** Extend `buildAuthorshipDecorations` in `authorship.ts` with a second pass that calls `doc.forEach` over top-level blocks, tallies character coverage by author, and emits a `Decoration.node()` with `data-tandem-author-block` for blocks where coverage exists. A `::before` pseudo-element in `editor.css` renders the gutter thread. Uses `data-tandem-author-block` (not `data-tandem-author`) to avoid colliding with the existing inline span CSS.

**Tech Stack:** ProseMirror/Tiptap decorations, TypeScript, Vitest

**Prerequisite:** #518A must be merged first (this plan diffs against the deleted `reviewMode` code).

---

## Files changed

| File | Action |
|---|---|
| `tests/client/authorship-decoration.test.ts` | Modify — extend mock + add 8 new tests |
| `src/client/editor/extensions/authorship.ts` | Modify — add dominant-author second pass |
| `src/client/editor/editor.css` | Modify — add `[data-tandem-author-block]::before` rules |

---

### Task 1: Extend test mock to capture Decoration.node() calls

**Files:**
- Modify: `tests/client/authorship-decoration.test.ts`

- [ ] **Step 1: Add capturedNodes array and extend the mock**

At the top of the file (around line 13), add the `capturedNodes` array alongside `capturedInlines`:

```ts
type CapturedInline = { from: number; to: number; attrs: Record<string, string> };
type CapturedNode = { from: number; to: number; attrs: Record<string, string> };
let capturedInlines: CapturedInline[] = [];
let capturedNodes: CapturedNode[] = [];
```

In the `vi.mock("@tiptap/pm/view", ...)` block, add a `node` method to the `Decoration` mock:

```ts
vi.mock("@tiptap/pm/view", () => {
  const empty = Symbol("DecorationSet.empty");
  return {
    DecorationSet: {
      empty,
      create(_doc: unknown, decorations: unknown[]) {
        return { decorations, _tag: "created" };
      },
    },
    Decoration: {
      inline(from: number, to: number, attrs: Record<string, string>) {
        const d = { from, to, attrs, _type: "inline" };
        capturedInlines.push(d);
        return d;
      },
      node(from: number, to: number, attrs: Record<string, string>) {
        const d = { from, to, attrs, _type: "node" };
        capturedNodes.push(d);
        return d;
      },
    },
  };
});
```

- [ ] **Step 2: Reset capturedNodes in beforeEach**

In the `beforeEach` block:

```ts
beforeEach(() => {
  capturedInlines = [];
  capturedNodes = [];
});
```

- [ ] **Step 3: Update makeMockDoc to support a realistic forEach**

The current `makeMockDoc` has `forEach: () => {}` which never calls its callback. The new second pass needs `forEach` to call the callback for each top-level block. Replace `makeMockDoc` with:

```ts
function makeMockDoc(
  blocks: Array<{
    typeName: string;
    size: number;
    offset: number;
  }> = [{ typeName: "paragraph", size: 10, offset: 1 }],
  totalSize = 100,
) {
  return {
    content: { size: totalSize },
    forEach(
      cb: (node: unknown, offset: number, index: number) => void,
    ) {
      blocks.forEach(({ typeName, size, offset }, i) => {
        cb(
          {
            type: { name: typeName },
            nodeSize: size + 2,
            content: { size },
          },
          offset,
          i,
        );
      });
    },
  } as unknown as import("@tiptap/pm/model").Node;
}
```

- [ ] **Step 4: Run tests to confirm existing tests still pass (forEach was a no-op before)**

```bash
npm test -- tests/client/authorship-decoration.test.ts
```

Expected: all 6 existing tests pass. The `capturedNodes` array is empty in all of them because the second pass hasn't been written yet.

---

### Task 2: Write failing tests for node decorations

**Files:**
- Modify: `tests/client/authorship-decoration.test.ts`

- [ ] **Step 1: Add tests for node decorations**

Add the following tests inside the `describe("buildAuthorshipDecorations", ...)` block, after the existing tests:

```ts
it("emits data-tandem-author-block for a single-author paragraph (claude)", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  addEntry(authorshipMap, "claude", "auth-1", 1, 5);

  const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(1);
  expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("claude");
});

it("emits data-tandem-author-block='user' when user has more chars (majority wins)", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  // claude: 3 chars (1..4), user: 5 chars (4..9)
  addEntry(authorshipMap, "claude", "auth-claude", 1, 4);
  addEntry(authorshipMap, "user", "auth-user", 4, 9);

  const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(1);
  expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
});

it("tie-breaks to user when claude and user have equal coverage", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  addEntry(authorshipMap, "claude", "auth-claude", 1, 4); // 3 chars
  addEntry(authorshipMap, "user", "auth-user", 4, 7);    // 3 chars

  const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(1);
  expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
});

it("authorship range spanning two paragraphs gives each its own node decoration", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  // Range spans both blocks: para1 offset 1..11, para2 offset 13..23
  addEntry(authorshipMap, "user", "auth-1", 1, 23);

  const doc = makeMockDoc([
    { typeName: "paragraph", size: 10, offset: 1 },
    { typeName: "paragraph", size: 10, offset: 13 },
  ], 30);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(2);
  expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
  expect(capturedNodes[1].attrs["data-tandem-author-block"]).toBe("user");
});

it("import author entries are excluded from node decorations", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  addEntry(authorshipMap, "import" as any, "auth-import", 1, 8);

  const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(0);
});

it("heading node receives a gutter decoration", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  addEntry(authorshipMap, "user", "auth-1", 1, 5);

  const doc = makeMockDoc([{ typeName: "heading", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(1);
  expect(capturedNodes[0].attrs["data-tandem-author-block"]).toBe("user");
});

it("bullet_list node does NOT receive a gutter decoration", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  addEntry(authorshipMap, "claude", "auth-1", 1, 8);

  const doc = makeMockDoc([{ typeName: "bullet_list", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(0);
});

it("block with no authorship coverage gets no node decoration", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  // No entries in map

  const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, true);

  expect(capturedNodes).toHaveLength(0);
});

it("visible=false skips both inline and node decoration passes", () => {
  const ydoc = new Y.Doc();
  const authorshipMap = ydoc.getMap(Y_MAP_AUTHORSHIP);
  addEntry(authorshipMap, "user", "auth-1", 1, 5);

  const doc = makeMockDoc([{ typeName: "paragraph", size: 10, offset: 1 }]);
  buildAuthorshipDecorations(doc, authorshipMap, ydoc, false);

  expect(capturedInlines).toHaveLength(0);
  expect(capturedNodes).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- tests/client/authorship-decoration.test.ts
```

Expected: the 9 new tests fail (capturedNodes is always empty). The original 6 tests continue to pass.

---

### Task 3: Implement the dominant-author second pass

**Files:**
- Modify: `src/client/editor/extensions/authorship.ts`

- [ ] **Step 1: Add the node-decoration second pass to buildAuthorshipDecorations**

The current function ends at line 76 with `return DecorationSet.create(doc, decorations)`. Before that return, add the second pass. The complete new `buildAuthorshipDecorations` function body is:

```ts
export function buildAuthorshipDecorations(
  doc: PmNode,
  authorshipMap: Y.Map<unknown>,
  ydoc: Y.Doc,
  visible: boolean,
): DecorationSet {
  if (!visible) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const maxPos = doc.content.size;

  // --- Pass 1: inline character-level authorship spans (existing) ---
  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    if (!entry.author || !entry.range) return;

    const validAuthors: ReadonlyArray<string> = ["user", "claude"];
    if (!validAuthors.includes(entry.author)) return;

    const resolved = resolveAuthorshipRange(entry, doc, ydoc);
    if (!resolved) return;

    const { from, to } = resolved;
    if (from >= to || from < 0 || to > maxPos) return;

    const attrs: Record<string, string> = {
      "data-tandem-author": entry.author,
    };

    try {
      decorations.push(Decoration.inline(from, to, attrs));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.warn("[authorship] Decoration RangeError for entry", entry.id, err);
    }
  });

  // --- Pass 2: per-block dominant-author gutter decoration ---
  const GUTTER_NODE_TYPES = new Set(["paragraph", "heading"]);

  // Pre-resolve all authorship ranges once so the forEach loop is O(blocks * entries)
  // rather than re-resolving per block.
  type ResolvedEntry = { author: "user" | "claude"; from: number; to: number };
  const resolved: ResolvedEntry[] = [];
  authorshipMap.forEach((value) => {
    const entry = value as AuthorshipRange;
    if (!entry.author || !entry.range) return;
    if (entry.author !== "user" && entry.author !== "claude") return;
    const r = resolveAuthorshipRange(entry, doc, ydoc);
    if (!r || r.from >= r.to) return;
    resolved.push({ author: entry.author as "user" | "claude", from: r.from, to: r.to });
  });

  doc.forEach((node, offset) => {
    if (!GUTTER_NODE_TYPES.has(node.type.name)) return;

    // Block spans [offset, offset + nodeSize) in PM positions.
    const blockFrom = offset;
    const blockTo = offset + node.nodeSize;

    let userChars = 0;
    let claudeChars = 0;

    for (const r of resolved) {
      // Compute overlap between authorship range and block
      const overlapFrom = Math.max(r.from, blockFrom);
      const overlapTo = Math.min(r.to, blockTo);
      if (overlapTo <= overlapFrom) continue;
      const chars = overlapTo - overlapFrom;
      if (r.author === "user") userChars += chars;
      else claudeChars += chars;
    }

    if (userChars === 0 && claudeChars === 0) return;

    // Ties go to user
    const dominant: "user" | "claude" = userChars >= claudeChars ? "user" : "claude";

    try {
      decorations.push(
        Decoration.node(blockFrom, blockTo, { "data-tandem-author-block": dominant }),
      );
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.warn("[authorship] node Decoration RangeError at offset", offset, err);
    }
  });

  return DecorationSet.create(doc, decorations);
}
```

- [ ] **Step 2: Run tests**

```bash
npm test -- tests/client/authorship-decoration.test.ts
```

Expected: all 15 tests pass (6 original + 9 new).

---

### Task 4: Add gutter CSS to editor.css

**Files:**
- Modify: `src/client/editor/editor.css`

- [ ] **Step 1: Verify paragraph and heading have position: relative**

```bash
grep -n "position.*relative\|p,\|h1,\|h2,\|h3,\|paragraph\|heading" src/client/editor/editor.css | head -20
```

The `::before` pseudo-element uses `position: absolute`, so the block element needs `position: relative`. If you see that `.tandem-editor p`, `.tandem-editor h1`, etc. (or `.ProseMirror p`) already have `position: relative`, skip Step 2.

- [ ] **Step 2: Add position: relative if not already present**

If ProseMirror paragraph and heading elements don't have `position: relative`, add to `editor.css`:

```css
.tandem-editor .ProseMirror p,
.tandem-editor .ProseMirror h1,
.tandem-editor .ProseMirror h2,
.tandem-editor .ProseMirror h3,
.tandem-editor .ProseMirror h4,
.tandem-editor .ProseMirror h5,
.tandem-editor .ProseMirror h6 {
  position: relative;
}
```

- [ ] **Step 3: Add the ::before gutter rules**

Append to `editor.css`:

```css
/* Authorship gutter — 2px colored thread on left margin of paragraph/heading blocks */
.tandem-editor [data-tandem-author-block]::before {
  content: '';
  position: absolute;
  left: -14px;
  top: 0.45em;
  bottom: 0.45em;
  width: 2px;
  border-radius: 1px;
  transition: background 200ms;
}
.tandem-editor [data-tandem-author-block="user"]::before {
  background: var(--tandem-author-user);
  opacity: 0.55;
}
.tandem-editor [data-tandem-author-block="claude"]::before {
  background: var(--tandem-author-claude);
  opacity: 0.55;
}
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: 0 errors, 0 warnings.

---

### Task 5: Run full test suite and commit

- [ ] **Step 1: Run all unit tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 2: Commit**

```bash
git add src/client/editor/extensions/authorship.ts src/client/editor/editor.css tests/client/authorship-decoration.test.ts
git commit -m "feat(#518B): add per-paragraph authorship gutter decoration"
```
