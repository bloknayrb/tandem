/**
 * #1123, the add-model window's fields (R6): source pins for what the window's
 * behaviour tests cannot see — where its fields are written, that no effect
 * moves them, that Save is never natively disabled, that the reason line is not
 * a live region, and that the address rule exists once, in the shared module.
 * Read over sources with comments stripped and `\r\n` normalised.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

/** HTML comments cut by position, not a regex replace: this is a test reading
 *  its own repo's source, never sanitising HTML. An unclosed one cuts to the end. */
function withoutHtmlComments(source: string): string {
  let out = "";
  let at = 0;
  for (let open = source.indexOf("<!--", at); open !== -1; open = source.indexOf("<!--", at)) {
    out += source.slice(at, open);
    const close = source.indexOf("-->", open + 4);
    if (close === -1) return out;
    at = close + 3;
  }
  return out + source.slice(at);
}

/** The source with `\r\n` normalised and block, line and HTML comments cut. */
function read(rel: string): string {
  return withoutHtmlComments(fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The balanced `{ … }` body starting at the first `{` at or after `from`. */
function braceBody(src: string, from: number): { start: number; end: number } {
  const open = src.indexOf("{", from);
  if (open === -1) throw new Error("no body");
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return { start: open, end: i + 1 };
  }
  throw new Error("unbalanced body");
}

/** The balanced `( … )` starting at the `(` at `open`. */
function parenSpan(src: string, open: number): { start: number; end: number } {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return { start: open, end: i + 1 };
  }
  throw new Error("unbalanced parens");
}

const indexes = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m.index ?? -1);
const inside = (i: number, span: { start: number; end: number }) => i >= span.start && i < span.end;

const WINDOW = read("src/client/components/ModelEditModal.svelte");
const SCRIPT = WINDOW.slice(WINDOW.indexOf("<script"), WINDOW.indexOf("</script>"));
const MARKUP = WINDOW.slice(WINDOW.indexOf("</script>"));

function fnBody(src: string, name: string) {
  const at = src.indexOf(`function ${name}(`);
  expect(at, `function ${name}`).toBeGreaterThan(-1);
  return braceBody(src, src.indexOf(")", at));
}

/** The opening tag (from `<tag` to its closing `>`) whose attributes contain `marker`. */
function openingTag(markup: string, tag: string, marker: string): string {
  for (const start of indexes(markup, new RegExp(`<${tag}\\b`, "g"))) {
    let depth = 0;
    for (let i = start; i < markup.length; i++) {
      const c = markup[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        const t = markup.slice(start, i + 1);
        if (t.includes(marker)) return t;
        break;
      }
    }
  }
  throw new Error(`no <${tag}> with ${marker}`);
}

describe("ModelEditModal — where the fields are written (R1.2, R2, R7)", () => {
  const select = fnBody(SCRIPT, "selectProvider");

  it("`endpoint` is assigned only at its $state declaration and inside selectProvider", () => {
    const hits = indexes(SCRIPT, /(?<![.\w])endpoint\s*(?:\|\||&&|\?\?|[-+*/%|&])?=(?!=)/g);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const i of hits) {
      const decl = /^endpoint\s*=\s*\$state\(/.test(SCRIPT.slice(i));
      expect(decl || inside(i, select), SCRIPT.slice(i, i + 60)).toBe(true);
    }
    expect(MARKUP).not.toMatch(/(?<![.\w:-])endpoint\s*(?:\|\||&&|\?\?|[-+*/%|&])?=(?!=)/);
  });

  it("`displayName` is assigned only at its $state declaration", () => {
    const hits = indexes(WINDOW, /(?<![.\w])displayName\s*(?:\|\||&&|\?\?|[-+*/%|&])?=(?!=)/g);
    expect(hits).toHaveLength(1);
    expect(WINDOW.slice(hits[0])).toMatch(/^displayName\s*=\s*\$state\(/);
  });

  it("endpointAfterProviderChange( occurs once, inside selectProvider", () => {
    const hits = indexes(SCRIPT, /endpointAfterProviderChange\(/g);
    expect(hits).toHaveLength(1);
    expect(inside(hits[0], select)).toBe(true);
  });

  it("no $effect body mentions the fields, and the one effect is the Tab trap", () => {
    const effects = indexes(SCRIPT, /\$effect(\.pre)?\(/g);
    expect(effects).toHaveLength(1);
    for (const at of effects) {
      const body = SCRIPT.slice(...Object.values(parenSpan(SCRIPT, SCRIPT.indexOf("(", at))));
      expect(body).not.toMatch(/\b(endpoint|provider|displayName|saveReason)\b/);
      expect(body).toContain("trapTab");
    }
  });

  it("modelSaveReason( occurs once, inside $derived(", () => {
    const hits = indexes(WINDOW, /modelSaveReason\(/g);
    expect(hits).toHaveLength(1);
    const derived = indexes(SCRIPT, /\$derived\(/g).map((at) =>
      parenSpan(SCRIPT, SCRIPT.indexOf("(", at)),
    );
    const at = SCRIPT.indexOf("modelSaveReason(");
    expect(derived.some((span) => inside(at, span))).toBe(true);
  });

  it("nameFallback( occurs exactly at the two Add sites: the placeholder and the save", () => {
    const hits = indexes(WINDOW, /nameFallback\(/g);
    expect(hits).toHaveLength(2);
    const submit = fnBody(SCRIPT, "handleSubmit");
    const scriptAt = WINDOW.indexOf(SCRIPT);
    expect(hits.filter((i) => inside(i - scriptAt, submit))).toHaveLength(1);
    const nameTag = openingTag(MARKUP, "input", 'data-testid="model-edit-displayname"');
    expect(nameTag).toMatch(/placeholder=\{isEditing \? "" : nameFallback\(provider\)\}/);
  });
});

describe("ModelEditModal — Save and its reason line (R3.3, R3.4)", () => {
  const save = openingTag(MARKUP, "button", 'data-testid="model-edit-save"');
  it("Save has no inline disabled= attribute (aria-disabled and class: aside)", () => {
    expect(save).toContain("aria-disabled=");
    expect(save).not.toMatch(/(?<![-\w:])disabled\s*=/);
  });
  it("the reason line is no live region", () => {
    const line = openingTag(MARKUP, "p", 'data-testid="model-edit-save-reason"');
    expect(line).not.toMatch(/aria-live|role=/);
  });
});

describe("one address rule (R3.5)", () => {
  it("local-model-copy.ts imports validateEndpoint from the shared module and copies nothing", () => {
    const copy = read("src/client/utils/local-model-copy.ts");
    expect(copy).toMatch(
      /import\s*\{\s*validateEndpoint\s*\}\s*from\s*"\.\.\/\.\.\/shared\/models\/local-endpoint\.js"/,
    );
    expect(copy).not.toContain("new URL(");
    expect(copy).not.toMatch(/["']127\.0\.0\.1["']/);
    expect(copy).not.toMatch(/["']localhost["']/);
    expect(copy).not.toMatch(/["']::1["']/);
  });

  it("the first-run window has no NAME_FALLBACK and calls endpointAfterProviderChange once", () => {
    const picker = read("src/client/components/FirstRunModelPickerModal.svelte");
    expect(picker).not.toContain("NAME_FALLBACK");
    expect(indexes(picker, /endpointAfterProviderChange\(/g)).toHaveLength(1);
  });

  it("validateEndpoint( occurs once in the copy; the first-run window names neither it nor local-endpoint (26a)", () => {
    const copy = read("src/client/utils/local-model-copy.ts");
    expect(indexes(copy, /validateEndpoint\(/g)).toHaveLength(1);
    const picker = read("src/client/components/FirstRunModelPickerModal.svelte");
    expect(picker).not.toContain("validateEndpoint");
    // A second import of the shared rule would be a second place to keep in step.
    expect(picker).not.toContain("local-endpoint");
  });

  it("the add-model window has no CollapsibleSection and no 'Advanced parameters' (26b)", () => {
    expect(WINDOW).not.toContain("CollapsibleSection");
    expect(WINDOW).not.toContain("Advanced parameters");
  });

  it("config.ts defines no LOOPBACK_HOSTS and re-exports the shared rule", () => {
    const config = read("src/server/local-model/config.ts");
    expect(config).not.toMatch(/\bLOOPBACK_HOSTS\b/);
    expect(config).toMatch(/from\s*"\.\.\/\.\.\/shared\/models\/local-endpoint\.js"/);
  });
});
