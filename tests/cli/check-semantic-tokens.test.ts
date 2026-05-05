import { describe, expect, it } from "vitest";
import { checkContent, shouldSkipFile } from "../../scripts/check-semantic-tokens.js";

describe("check-semantic-tokens", () => {
  it("flags raw hex colors inside Svelte style blocks", () => {
    const violations = checkContent(
      `<script lang="ts">
        const label = "test";
      </script>

      <style>
        .danger {
          color: #dc2626;
        }
      </style>`,
      "src/client/components/Example.svelte",
    );

    expect(violations).toEqual(["src/client/components/Example.svelte:7: #dc2626"]);
  });

  it("skips only the known legacy Svelte harness files", () => {
    expect(shouldSkipFile("src/client/svelte-harness/Harness.svelte")).toBe(true);
    expect(shouldSkipFile("src/client/svelte-harness/HookDebug.svelte")).toBe(true);
    expect(shouldSkipFile("src/client/svelte-harness/NewHarnessFile.svelte")).toBe(false);
  });

  it("allows neutral rgba values", () => {
    const violations = checkContent(
      `<style>
        .modal {
          background: rgba(0, 0, 0, 0.45);
          box-shadow: 0 8px 32px rgba(0,0,0,0.24);
        }
      </style>`,
      "src/client/components/Modal.svelte",
    );

    expect(violations).toEqual([]);
  });

  it("flags raw border radius pixels", () => {
    const violations = checkContent(
      `<div style="border-radius: 6px; background: var(--tandem-surface);"></div>`,
      "src/client/components/RadiusExample.svelte",
    );

    expect(violations).toEqual([
      "src/client/components/RadiusExample.svelte:1: border-radius: 6px",
    ]);
  });

  it("flags inline box-shadow rgba so surfaces migrate to shadow tokens", () => {
    const violations = checkContent(
      `<div style="box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);"></div>`,
      "src/client/components/ShadowExample.svelte",
    );

    expect(violations).toEqual([
      "src/client/components/ShadowExample.svelte:1: box-shadow: 0 4px 12px rgba(",
    ]);
  });
});
