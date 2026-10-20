/**
 * The wizard's saved-setup merge (#2198). Before it, an Apply rebuilt
 * `integrations.json` from the picked cards alone — dropping the working
 * directory Tandem's Claude spawns in, token refs, other-mcp records and the
 * default — and the v1.0 walkthrough sends every upgrader through that Apply.
 */
import { describe, expect, it } from "vitest";

import {
  buildSaveFile,
  isSomethingSetUp,
  type MergePicked,
  matchRecord,
  picksSomethingNew,
  preselects,
  recordToConfig,
} from "../../src/client/hooks/integration-wizard-merge";
import {
  type ExistingMcpInstall,
  INTEGRATIONS_SCHEMA_VERSION,
  type IntegrationConfig,
  type IntegrationsFile,
} from "../../src/shared/integrations/contract";

const ccInstall = (configPath = "/home/u/.claude.json", extra: Partial<ExistingMcpInstall> = {}) =>
  ({
    target: { kind: "claude-code", label: "Claude Code", configPath },
    status: "ok",
    ...extra,
  }) as ExistingMcpInstall;

const desktopInstall = (configPath: string) =>
  ({
    target: { kind: "claude-desktop", label: "Claude Desktop", configPath },
    status: "ok",
  }) as ExistingMcpInstall;

const ccRecord = (over: Partial<IntegrationConfig> = {}): IntegrationConfig =>
  ({
    kind: "claude-code",
    id: "cc-saved",
    label: "Claude Code",
    configPath: "/home/u/.claude.json",
    transport: "http",
    url: "http://127.0.0.1:3479/mcp",
    tokenSecretRef: "cc-saved-ref",
    workingDirectory: "/home/u/projects/novel",
    apply: "create",
    ...over,
  }) as IntegrationConfig;

const otherMcp: IntegrationConfig = {
  kind: "other-mcp",
  id: "other-1",
  label: "Something else",
  transport: "http",
  url: "http://127.0.0.1:9000/mcp",
  apply: "skip",
};

const file = (
  integrations: IntegrationConfig[],
  defaultIntegrationId?: string,
): IntegrationsFile => ({
  schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
  integrations,
  ...(defaultIntegrationId ? { defaultIntegrationId } : {}),
});

const cardFrom = (install: ExistingMcpInstall, record: IntegrationConfig): MergePicked => ({
  id: record.id,
  config: recordToConfig(install, record),
  fromRecord: true,
});

describe("picksSomethingNew (#2199)", () => {
  const valid = ccInstall("/home/u/.claude.json", {
    tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
    tandemValidation: { status: "valid" },
  } as Partial<ExistingMcpInstall>);
  const fresh = (path: string): MergePicked => ({
    id: "new-1",
    config: {
      ...ccRecord({ id: "new-1", configPath: path }),
      apply: undefined,
    } as IntegrationConfig,
  });

  it("the saved setup, or what is already set up on disk, is not new", () => {
    expect(picksSomethingNew([cardFrom(ccInstall(), ccRecord())], [ccInstall()])).toBe(false);
    expect(picksSomethingNew([fresh("/home/u/.claude.json")], [valid])).toBe(false);
  });

  it("a ticked card with no Tandem entry on disk is new — matched case- and separator-folded", () => {
    expect(picksSomethingNew([fresh("/home/u/.claude.json")], [ccInstall()])).toBe(true);
    expect(picksSomethingNew([fresh("\\HOME\\u\\.claude.json")], [valid])).toBe(false);
  });
});

describe("matchRecord", () => {
  it("by config path, separator- and case-folded", () => {
    const record = ccRecord({ configPath: "C:\\Users\\U\\.claude.json" } as never);
    const install = ccInstall("c:/users/u/.claude.json");
    expect(matchRecord(install, [record], [install])).toBe(record);
  });

  it("by kind alone when there is exactly one of each", () => {
    const record = ccRecord({ configPath: "/old/home/.claude.json" } as never);
    const install = ccInstall("/home/u/.claude.json");
    expect(matchRecord(install, [record], [install])).toBe(record);
  });

  it("not by kind when two installs of it are detected", () => {
    const record = { ...ccRecord(), kind: "claude-desktop", transport: "stdio", configPath: "/a" };
    const a = desktopInstall("/b");
    const b = desktopInstall("/c");
    expect(matchRecord(a, [record as IntegrationConfig], [a, b])).toBeUndefined();
  });
});

describe("pre-fill", () => {
  it("a card built from its record keeps the record's id, token ref and working directory", () => {
    const install = ccInstall();
    const config = recordToConfig(install, ccRecord());
    expect(config).toMatchObject({
      id: "cc-saved",
      tokenSecretRef: "cc-saved-ref",
      workingDirectory: "/home/u/projects/novel",
    });
    expect(config).not.toHaveProperty("apply");
  });

  it("nothing set up: everything connectable is preselected, as before", () => {
    const install = ccInstall();
    expect(isSomethingSetUp([install], [])).toBe(false);
    expect(preselects(install, undefined, false)).toBe(true);
  });

  it("set up: a saved record decides for itself, and skip is the user's own 'disabled'", () => {
    const install = ccInstall();
    expect(isSomethingSetUp([install], [ccRecord()])).toBe(true);
    expect(preselects(install, ccRecord(), true)).toBe(true);
    expect(preselects(install, ccRecord({ apply: "skip" }), true)).toBe(false);
  });

  it("set up elsewhere: an install with no record is preselected only with a valid entry on disk", () => {
    const bare = desktopInstall("/d");
    const withEntry = ccInstall("/home/u/.claude.json", {
      tandemEntry: { type: "http", url: "http://127.0.0.1:3479/mcp" },
      tandemValidation: { status: "valid" },
    } as never);
    expect(isSomethingSetUp([bare, withEntry], [])).toBe(true);
    expect(preselects(bare, undefined, true)).toBe(false);
    expect(preselects(withEntry, undefined, true)).toBe(true);
  });

  it("an other-mcp record alone does not make the pre-fill selective", () => {
    expect(isSomethingSetUp([ccInstall()], [otherMcp])).toBe(false);
  });
});

describe("buildSaveFile", () => {
  const empty = new Set<string>();
  const refs = (records: IntegrationConfig[]) =>
    new Map(records.map((r) => [r.id, r.tokenSecretRef]));

  it("keeps what the wizard does not own: other-mcp, undetected records, the default — in their order", () => {
    const install = ccInstall();
    const desktopNotDetected = {
      kind: "claude-desktop",
      id: "cd-1",
      label: "Claude Desktop",
      configPath: "/elsewhere/claude_desktop_config.json",
      transport: "stdio",
      nodeBinary: "/opt/node/bin/node",
    } as IntegrationConfig;
    const saved = file([otherMcp, ccRecord(), desktopNotDetected], "cd-1");
    const out = buildSaveFile({
      saved,
      picked: [cardFrom(install, ccRecord())],
      existing: [install],
      deselected: empty,
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations.map((i) => i.id)).toEqual(["other-1", "cc-saved", "cd-1"]);
    expect(out.file.integrations[0]).toEqual(otherMcp);
    expect(out.file.integrations[2]).toEqual(desktopNotDetected);
    expect(out.file.integrations[1]).toMatchObject({
      tokenSecretRef: "cc-saved-ref",
      workingDirectory: "/home/u/projects/novel",
      apply: "create",
    });
    expect(out.file.defaultIntegrationId).toBe("cd-1");
    // Only the picked card is applied — never a kept record.
    expect(out.applyIds).toEqual(["cc-saved"]);
    expect(out.superseded).toEqual([]);
  });

  it("builds from the record re-read at save time: a cwd changed meanwhile survives", () => {
    const install = ccInstall();
    const atBegin = ccRecord();
    const atSave = ccRecord({ workingDirectory: "/home/u/projects/thesis" } as never);
    const out = buildSaveFile({
      saved: file([atSave]),
      picked: [cardFrom(install, atBegin)],
      existing: [install],
      deselected: empty,
      originalRefs: refs([atBegin]),
    });
    expect(out.file.integrations[0]).toMatchObject({ workingDirectory: "/home/u/projects/thesis" });
  });

  it("a record the user unchecked is kept as skip, its token and cwd with it", () => {
    const saved = file([ccRecord()]);
    const out = buildSaveFile({
      saved,
      picked: [],
      existing: [ccInstall()],
      deselected: new Set(["cc-saved"]),
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations[0]).toMatchObject({
      apply: "skip",
      tokenSecretRef: "cc-saved-ref",
      workingDirectory: "/home/u/projects/novel",
    });
    expect(out.applyIds).toEqual([]);
  });

  it("a record never picked (not deselected) is kept unchanged", () => {
    const saved = file([ccRecord({ apply: "skip" })]);
    const out = buildSaveFile({
      saved,
      picked: [],
      existing: [ccInstall()],
      deselected: empty,
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations[0]).toEqual(ccRecord({ apply: "skip" }));
  });

  it("a newly entered token replaces the saved ref, and the old one is reported superseded", () => {
    const install = ccInstall();
    const saved = file([ccRecord()]);
    const card = cardFrom(install, ccRecord());
    card.config = { ...card.config, tokenSecretRef: "cc-saved-new" } as IntegrationConfig;
    const out = buildSaveFile({
      saved,
      picked: [card],
      existing: [install],
      deselected: empty,
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations[0]).toMatchObject({ tokenSecretRef: "cc-saved-new" });
    expect(out.superseded).toEqual(["cc-saved-ref"]);
  });

  it("a replaced ref another record still holds (a hand-edited file) is never reported superseded", () => {
    const install = ccInstall();
    const sharing = { ...otherMcp, tokenSecretRef: "cc-saved-ref" } as IntegrationConfig;
    const saved = file([ccRecord(), sharing]);
    const card = cardFrom(install, ccRecord());
    card.config = { ...card.config, tokenSecretRef: "cc-saved-new" } as IntegrationConfig;
    const out = buildSaveFile({
      saved,
      picked: [card],
      existing: [install],
      deselected: empty,
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations[1]).toMatchObject({ tokenSecretRef: "cc-saved-ref" });
    expect(out.superseded).toEqual([]);
  });

  it("new picks append after the saved records", () => {
    const desktop = desktopInstall("/d/claude_desktop_config.json");
    const fresh: MergePicked = {
      id: "claude-desktop-new",
      config: {
        kind: "claude-desktop",
        id: "claude-desktop-new",
        label: "Claude Desktop",
        configPath: "/d/claude_desktop_config.json",
        transport: "stdio",
      },
    };
    const saved = file([ccRecord()]);
    const out = buildSaveFile({
      saved,
      picked: [fresh],
      existing: [ccInstall(), desktop],
      deselected: empty,
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations.map((i) => i.id)).toEqual(["cc-saved", "claude-desktop-new"]);
    expect(out.applyIds).toEqual(["claude-desktop-new"]);
  });

  it("a default that does not survive is dropped rather than left dangling", () => {
    const out = buildSaveFile({
      saved: file([ccRecord()], "gone"),
      picked: [],
      existing: [],
      deselected: empty,
      originalRefs: new Map(),
    });
    expect(out.file).not.toHaveProperty("defaultIntegrationId");
  });

  it("a picked entry whose on-disk entry failed validation is saved as skip", () => {
    const install = ccInstall("/home/u/.claude.json", {
      tandemEntry: { type: "http", url: "x" },
      tandemValidation: { status: "invalid", reason: "hand-edited" },
    } as never);
    const saved = file([ccRecord()]);
    const out = buildSaveFile({
      saved,
      picked: [cardFrom(install, ccRecord())],
      existing: [install],
      deselected: empty,
      originalRefs: refs(saved.integrations),
    });
    expect(out.file.integrations[0]).toMatchObject({ apply: "skip" });
  });
  it("a card whose record is gone from the fresh read is stale: not re-added from the old copy", () => {
    const install = ccInstall();
    const out = buildSaveFile({
      saved: file([]),
      picked: [cardFrom(install, ccRecord())],
      existing: [install],
      deselected: new Set(),
      originalRefs: new Map([["cc-saved", "cc-saved-ref"]]),
    });
    expect(out.stale).toBe(true);
  });

  it("the ref a new token replaces is the one on disk now, not the one read at open", () => {
    const install = ccInstall();
    const card = cardFrom(install, ccRecord());
    card.config = { ...card.config, tokenSecretRef: "cc-new" } as IntegrationConfig;
    const out = buildSaveFile({
      saved: file([ccRecord({ tokenSecretRef: "cc-rotated-elsewhere" })]),
      picked: [card],
      existing: [install],
      deselected: new Set(),
      originalRefs: new Map([["cc-saved", "cc-saved-ref"]]),
    });
    expect(out.superseded).toEqual(["cc-rotated-elsewhere"]);
    expect(out.stale).toBe(false);
  });
});
