import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Protected-token snapshot gate for the design-system-impl umbrella branch.
 *
 * These tokens are load-bearing for shipped behavior (authorship decorations,
 * audience-first model, WCAG AA audit). Any change must come with an explicit
 * per-token re-audit committed alongside this snapshot update — see
 * docs/design-system-impl/token-audit.md for the full reconciliation and the
 * reasons each token is protected.
 *
 * Failure here means a sub-PR in the umbrella is silently drifting a protected
 * token away from the post-#556 / post-#776 audited values. Surface to review.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf-8");

/** Extract the body of a single CSS selector block from index.html. */
function extractBlock(selector: string): string {
  // index.html has multiple blocks for the same selector at the top level (one
  // initial `:root` and a later `[data-theme="dark"]` etc). We want the full
  // text of the first match — protected tokens are declared in the first block.
  const pattern = selector.replace(/\\/g, "\\\\").replace(/[.*+?^${}()|[\]]/g, "\\$&");
  const re = new RegExp(`${pattern}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, "m");
  const m = INDEX_HTML.match(re);
  if (!m) throw new Error(`block not found: ${selector}`);
  return m[1];
}

/** Extract a single token's declared value (right-hand side) from a block. */
function extractToken(block: string, name: string): string {
  const re = new RegExp(`${name}\\s*:\\s*([^;]+);`);
  const m = block.match(re);
  if (!m) throw new Error(`token not found in block: ${name}`);
  return m[1].trim();
}

const lightBlock = extractBlock(":root");
const darkBlock = extractBlock('[data-theme="dark"]');

describe("protected design tokens — light mode (:root)", () => {
  it.each([
    // Authorship — ADR-026 character-level decorations
    ["--tandem-author-user", "oklch(0.55 0.14 245)"],
    ["--tandem-author-claude", "#d97757"],
    ["--tandem-author-claude-fg", "oklch(0.24 0.03 55)"],
    [
      "--tandem-claude-focus-bg",
      "color-mix(in srgb, var(--tandem-author-claude) 10%, transparent)",
    ],
    [
      "--tandem-claude-focus-border",
      "color-mix(in srgb, var(--tandem-author-claude) 40%, transparent)",
    ],
    // Suggestion — ADR-027 audience-first model
    ["--tandem-suggestion", "oklch(0.52 0.18 305)"],
    ["--tandem-suggestion-fg-strong", "#5b21b6"],
    [
      "--tandem-suggestion-bg",
      "color-mix(in srgb, var(--tandem-suggestion) 10%, var(--tandem-surface))",
    ],
    [
      "--tandem-suggestion-border",
      "color-mix(in srgb, var(--tandem-suggestion) 40%, var(--tandem-border))",
    ],
    // WCAG AA audit-protected fg pair
    ["--tandem-fg-muted", "oklch(0.48 0.008 280)"],
    ["--tandem-fg-subtle", "oklch(0.54 0.008 280)"],
  ])("%s equals audited value %s", (token, expected) => {
    expect(extractToken(lightBlock, token)).toBe(expected);
  });
});

describe('protected design tokens — dark mode ([data-theme="dark"])', () => {
  it.each([
    ["--tandem-author-user", "oklch(0.72 0.13 245)"],
    ["--tandem-author-claude", "#e89a78"],
    ["--tandem-author-claude-fg", "oklch(0.24 0.03 55)"],
    [
      "--tandem-claude-focus-bg",
      "color-mix(in srgb, var(--tandem-author-claude) 10%, transparent)",
    ],
    [
      "--tandem-claude-focus-border",
      "color-mix(in srgb, var(--tandem-author-claude) 40%, transparent)",
    ],
    ["--tandem-suggestion", "#a78bfa"],
    ["--tandem-suggestion-fg-strong", "#ddd6fe"],
    ["--tandem-suggestion-bg", "#2e1065"],
    ["--tandem-suggestion-border", "#4c1d95"],
    ["--tandem-fg-muted", "oklch(0.74 0.008 280)"],
    ["--tandem-fg-subtle", "oklch(0.70 0.008 280)"],
  ])("%s equals audited value %s", (token, expected) => {
    expect(extractToken(darkBlock, token)).toBe(expected);
  });
});
