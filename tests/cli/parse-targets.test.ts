import { describe, expect, it } from "vitest";

import { parseChannelShimArgs, parseTargetArgs } from "../../src/cli/setup.js";

// `parseTargetArgs` is the pure core of `tandem setup --target=` handling.
// The exit-on-all-invalid guard lives in `src/cli/index.ts` (an untested
// entrypoint by repo convention); here we lock the parse logic it depends on.
describe("parseTargetArgs", () => {
  it("returns all valid targets and no unknowns", () => {
    const { targets, unknown } = parseTargetArgs([
      "--apply",
      "--target=claude-code",
      "--target=claude-desktop",
    ]);
    expect(targets).toEqual(["claude-code", "claude-desktop"]);
    expect(unknown).toEqual([]);
  });

  it("collects unrecognized values into `unknown` (the typo case index.ts aborts on)", () => {
    const { targets, unknown } = parseTargetArgs(["--apply", "--target=claude-cod"]);
    expect(targets).toEqual([]);
    expect(unknown).toEqual(["claude-cod"]);
  });

  it("honors partial validity — a valid + an invalid target keeps the valid one", () => {
    const { targets, unknown } = parseTargetArgs(["--target=claude-code", "--target=typo"]);
    expect(targets).toEqual(["claude-code"]);
    expect(unknown).toEqual(["typo"]);
  });

  it("treats an empty `--target=` value as an unknown (so it triggers the abort)", () => {
    const { targets, unknown } = parseTargetArgs(["--target="]);
    expect(targets).toEqual([]);
    expect(unknown).toEqual([""]);
  });

  it("ignores `--target` without `=` entirely (neither valid nor unknown)", () => {
    const { targets, unknown } = parseTargetArgs(["--target", "claude-code"]);
    expect(targets).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("returns both empty when no --target is given (caller treats as 'all detected')", () => {
    const { targets, unknown } = parseTargetArgs(["--apply", "--force"]);
    expect(targets).toEqual([]);
    expect(unknown).toEqual([]);
  });
});

// The three-way channel-shim intent (#1760). `undefined` is "preserve" and
// `false` is "remove" — collapsing them is data loss, which is why the parser
// is a pure function with its own specs rather than an inline `includes()`.
describe("parseChannelShimArgs", () => {
  it("reads --with-channel-shim as an explicit true", () => {
    expect(parseChannelShimArgs(["--apply", "--with-channel-shim"])).toEqual({
      intent: true,
      conflict: false,
    });
  });

  it("reads --without-channel-shim as an explicit false (the only removal path)", () => {
    expect(parseChannelShimArgs(["--apply", "--without-channel-shim"])).toEqual({
      intent: false,
      conflict: false,
    });
  });

  it("leaves intent undefined when neither flag is given — 'preserve', not 'remove'", () => {
    const parsed = parseChannelShimArgs(["--apply", "--force"]);
    expect(parsed.conflict).toBe(false);
    expect(parsed.intent).toBeUndefined();
  });

  it("reports a conflict when both flags are given, choosing neither", () => {
    const parsed = parseChannelShimArgs(["--with-channel-shim", "--without-channel-shim"]);
    expect(parsed.conflict).toBe(true);
    expect(parsed.intent).toBeUndefined();
  });
});
