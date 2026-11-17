import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #2422 seam: every other suite runs with `loopbackFetch` delegating to the
 * global `fetch` (tests/setup/loopback-fetch-passthrough.ts), so a request that
 * slipped back to the global `fetch` would be invisible to them. Pinned here
 * from source, for `src/cli`, `src/channel`, `src/monitor`, `src/shared` and
 * (since the #1123 follow-up) all of `src/server`, where the local-model client
 * carries the chat prompt and so the document's text, and the start-up instance
 * probe decides whether `freePort` may kill a running Tandem (#1758):
 *
 * - the bare identifier `fetch` appears nowhere but `typeof fetch` and an
 *   object key (`fetch: loopbackFetch`): a call, `= fetch`, `fetchImpl: fetch`,
 *   a shorthand `{ fetch }`, `cond ? x : fetch`, `return fetch`, `fetch.call(…)`
 *   and an argument are all caught;
 * - `globalThis.fetch`, `global.fetch`, `window.fetch`, `self.fetch`, their
 *   optional-chaining and bracket forms (`globalThis?.fetch`,
 *   `globalThis["fetch"]`) and the destructuring form
 *   (`const { fetch: f } = globalThis`) are forbidden;
 * - `undici` is imported only by `loopback-fetch.ts`, so no second,
 *   dispatcher-less `fetch` can be reached under another name;
 * - `node:http` / `node:https` / `http` / `https` are imported (statically,
 *   by `require` or by dynamic `import()`) only by `doctor.ts`, whose two
 *   probes pass a private agent (asserted below: an env proxy sends an
 *   absolute-form request through the default agent, which no `CONNECT`
 *   recorder shows).
 *
 * Exempt by rule, because neither can make a request: a declaration file
 * (`*.d.ts`, skipped whole), and a type-only import or re-export
 * (`import type … from "node:http"`, `export type … from "http"`), which TS
 * erases. A mixed import (`import { type A, B } from "http"`) is NOT exempt,
 * and neither is a type-position `import("node:http").Server` (it fails
 * closed: rewrite it as an `import type`). The type-import strip stops at the
 * first `;` or quote, which relies on biome writing statement semicolons.
 *
 * The scan reads strings and regex literals as code, so a message string or
 * a regex containing the word `fetch` (or an http module name) fails it: two
 * allowlist lines below exist only for that reason.
 *
 * Everything else that matches must be one of `ALLOWED`'s exact source lines,
 * each with its reason, and every entry must still match (no stale entries). A
 * new hit, including a second hit of an allowed kind in an allowed file, fails.
 *
 * What this cannot see:
 * - an alias for the global `fetch` imported from a module outside these
 *   directories;
 * - anything outside them (`probe/`, `scripts/`, `src-tauri/`, the client);
 * - a request made some other way (a spawned process, a websocket, a raw
 *   `net` socket), or by a dependency that makes the request itself;
 * - a `fetch` reached through an alias of the global object
 *   (`const g = globalThis; g.fetch`), `Reflect.get`, a computed key, a
 *   destructuring with a type annotation, cast or parentheses
 *   (`const { fetch: f }: Window = globalThis`, `= (globalThis)`), or
 *   `createRequire(…)("node:http")`;
 * - code the comment scanner misreads: it keeps strings, templates and regex
 *   literals, and tells a regex from division by the token before the `/`;
 *   a `/` that heuristic misjudges could hide code.
 * The real-process tests (`tests/cli/loopback-no-proxy.test.ts`,
 * `tests/server/local-model/loopback-no-proxy.test.ts`) cover the programs'
 * actual behaviour.
 */
const ROOT = resolve(__dirname, "../..");
const DIRS = ["src/cli", "src/channel", "src/monitor", "src/shared", "src/server"];
const LOOPBACK = "src/shared/loopback-fetch.ts";
const HTTP_ALLOWED = new Set(["src/cli/doctor.ts"]);

type Rule = "bare-fetch" | "global-fetch" | "undici-import" | "http-import";

// `fetch` not part of a longer name, a property (`x.fetch`), a path (`a-fetch.js`),
// and not an object key (`fetch:`) — except where `fetch :` is a ternary's
// then-arm (`cond ? fetch : loopbackFetch`), which is a value and is caught.
const BARE_FETCH = /(?<![\w.$/-])fetch\b(?!\s*:)|(?<=\?\s*)fetch\b(?=\s*:)/g;
const GLOBAL_FETCH = new RegExp(
  [
    String.raw`\b(?:globalThis|global|window|self)\s*(?:\?\.|\.)\s*fetch\b`,
    String.raw`\b(?:globalThis|global|window|self)\s*(?:\?\.)?\s*\[\s*["'\x60]fetch["'\x60]\s*\]`,
    // `const { fetch: f } = globalThis` / `({ fetch } = window)`.
    String.raw`\{[^{}]*\bfetch\b[^{}]*\}\s*=\s*(?:globalThis|global|window|self)\b`,
  ].join("|"),
  "g",
);
const UNDICI_IMPORT =
  /from\s+["']undici["']|require\(\s*["'`]undici["'`]\s*\)|import\(\s*["'`]undici["'`]\s*\)/g;
const HTTP_IMPORT =
  /from\s+["'](?:node:)?https?["']|require\(\s*["'`](?:node:)?https?["'`]\s*\)|import\(\s*["'`](?:node:)?https?["'`]\s*\)/g;

/**
 * Every hit outside `loopback-fetch.ts` (and `doctor.ts`'s HTTP import) that
 * is legitimate, by its exact trimmed source line. Verified by running the scan
 * at the commit that added `src/server`.
 */
const ALLOWED: readonly { file: string; rule: Rule; line: string; reason: string }[] = [
  {
    file: "src/server/license/kv-store.ts",
    rule: "bare-fetch",
    line: "const fetchFn = deps.fetchFn ?? fetch;",
    reason:
      "the licence Worker's Cloudflare KV REST API (api.cloudflare.com), a remote host where an environment proxy may be what the user needs; licensing ships dark",
  },
  {
    file: "src/server/integrations/install-claude-cli.ts",
    rule: "http-import",
    line: 'import { get as httpsGetDefault } from "node:https";',
    reason: "downloads the Claude CLI installer from a remote https host, never loopback",
  },
  {
    file: "src/server/integrations/install-claude-cli.ts",
    rule: "bare-fetch",
    line: "req.destroy(new Error(`Installer fetch timed out after ${FETCH_TIMEOUT_MS}ms`));",
    reason: "the word inside an error message, not code",
  },
  {
    file: "src/server/launcher/api-routes.ts",
    rule: "bare-fetch",
    line: 'message: "nonce mismatch (single-use; fetch a fresh one from GET /api/launcher/nonce)",',
    reason: "the word inside a response message, not code",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    // Any TS or JS module; declaration files are exempt by rule.
    return /\.[cm]?[tj]s$/.test(p) && !/\.d\.[cm]?ts$/.test(p) ? [p] : [];
  });
}

/**
 * Remove comments, keeping strings, template literals and regex literals
 * intact. A regex strip cannot do this: a `/*` inside a `//` comment (e.g.
 * "shared/*") or inside a string would open a fake block comment and hide
 * the live code up to the next `*\/`. Line breaks inside a removed block are
 * kept, so the line a hit is reported on stays meaningful.
 *
 * A `/` starts a regex literal when the last significant character before it
 * cannot end an expression (an operator, an opening bracket, `,`, `;`, `:`,
 * the start of the file) or the word before it is a keyword such as `return`;
 * otherwise it is division. That heuristic is the scanner's one judgment call.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let last = ""; // last significant code character emitted
  let lastWord = "";
  // Template nesting: each entry is the `{` depth at which a `${` resumes
  // the enclosing template.
  const templates: number[] = [];
  let depth = 0;
  const regexOk = () =>
    last === "" ||
    "([{,;:=!&|?+-*%<>~^".includes(last) ||
    /^(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(lastWord);
  const readTemplate = () => {
    // at the char after a backtick (or after the `}` closing a `${`)
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        i += 1;
        last = "`";
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        templates.push(depth);
        depth += 1;
        last = "{";
        return;
      }
      out += c;
      i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const body = src.slice(i, end === -1 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, "");
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      last = c;
      lastWord = "";
      continue;
    }
    if (c === "`") {
      out += c;
      i += 1;
      readTemplate();
      lastWord = "";
      continue;
    }
    if (c === "/" && regexOk()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      last = "/";
      lastWord = "";
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (templates.length > 0 && templates[templates.length - 1] === depth) {
        templates.pop();
        out += c;
        i += 1;
        readTemplate();
        continue;
      }
    }
    out += c;
    i += 1;
    if (/\w|\$/.test(c)) {
      lastWord = /\w|\$/.test(last) ? lastWord + c : c;
      last = c;
    } else if (!/\s/.test(c)) {
      last = c;
      lastWord = "";
    }
  }
  return out;
}

/** Comments out, `typeof fetch` neutralised, type-only imports/re-exports erased. */
function strip(raw: string): string {
  return (
    stripComments(raw)
      .replace(/typeof\s+fetch\b/g, "typeof _")
      // `import type X from "m"`, `import type { A, B } from "m"` (any line
      // breaks), `export type { A } from "m"`. `[^;"']*` cannot cross a string
      // or a statement end, so a value import is never swallowed.
      .replace(/^\s*(?:import|export)\s+type\b[^;"']*from\s*["'][^"']+["']\s*;?/gm, "")
  );
}

function sources(): { rel: string; code: string }[] {
  return DIRS.flatMap((d) => walk(join(ROOT, d))).map((f) => ({
    rel: f.slice(ROOT.length + 1).replace(/\\/g, "/"),
    code: strip(readFileSync(f, "utf8")),
  }));
}

/** Each match as `{file, rule, line}`, `line` the trimmed source line it is on. */
function hits(rule: Rule, re: RegExp): { file: string; rule: Rule; line: string }[] {
  return sources().flatMap(({ rel, code }) => {
    if (rel === LOOPBACK) return [];
    if (rule === "http-import" && HTTP_ALLOWED.has(rel)) return [];
    const lines = code.split("\n");
    return [...code.matchAll(re)].map((m) => {
      const n = code.slice(0, m.index).split("\n").length - 1;
      return { file: rel, rule, line: (lines[n] ?? "").trim() };
    });
  });
}

function allHits() {
  return [
    ...hits("bare-fetch", BARE_FETCH),
    ...hits("global-fetch", GLOBAL_FETCH),
    ...hits("undici-import", UNDICI_IMPORT),
    ...hits("http-import", HTTP_IMPORT),
  ];
}

const key = (h: { file: string; rule: Rule; line: string }) => `${h.file} [${h.rule}] ${h.line}`;

describe("no path around loopbackFetch in the programs that make loopback requests (#2422)", () => {
  it("finds the files it is meant to scan", () => {
    const rels = sources().map((s) => s.rel);
    expect(rels).toContain("src/cli/rotate-token.ts");
    expect(rels).toContain("src/cli/license.ts");
    expect(rels).toContain("src/shared/auth-fetch.ts");
    expect(rels).toContain("src/server/local-model/ollama-client.ts");
    expect(rels).toContain("src/server/platform.ts");
  });

  it("every hit is an allowlisted line: no bare or global fetch, no stray undici or http import", () => {
    const allowed = new Set(ALLOWED.map(key));
    expect(
      allHits()
        .map(key)
        .filter((k) => !allowed.has(k)),
    ).toEqual([]);
  });

  it("every allowlist entry still matches exactly one hit", () => {
    const counts = new Map<string, number>();
    for (const h of allHits()) counts.set(key(h), (counts.get(key(h)) ?? 0) + 1);
    expect(ALLOWED.map((a) => [key(a), counts.get(key(a)) ?? 0])).toEqual(
      ALLOWED.map((a) => [key(a), 1]),
    );
  });

  it("the two #1123 call sites use loopbackFetch", () => {
    const code = (rel: string) => sources().find((s) => s.rel === rel)?.code ?? "";
    const client = code("src/server/local-model/ollama-client.ts");
    // The client posts through `clientFetch`, which starts as and resets to
    // `loopbackFetch` (the harness seam, pinned in client-fetch-seam.test.ts).
    expect(client).toMatch(/await clientFetch\(url,/);
    expect(client).toMatch(/let clientFetch: typeof _ = loopbackFetch;/);
    expect(client).toMatch(/clientFetch = next \?\? loopbackFetch;/);
    expect(code("src/server/platform.ts")).toMatch(
      /await loopbackFetch\(`http:\/\/\$\{authority\}/,
    );
  });

  it("the doctor's request sites all pass the private agent", () => {
    const doctor = sources().find((s) => s.rel === "src/cli/doctor.ts")?.code ?? "";
    const sites = doctor.match(/(?<![\w.$])request\(/g) ?? [];
    const agents = doctor.match(/agent:\s*PROBE_AGENT\b/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    expect(agents.length).toBe(sites.length);
    expect(doctor).toMatch(/const PROBE_AGENT = new Agent\(\)/);
  });
});

describe("the scan's patterns catch the forms they claim to (controls)", () => {
  const caught = (re: RegExp, src: string) => [...strip(src).matchAll(re)].length > 0;

  it.each([
    "const r = await fetch(url);",
    "const f = cond ? x : fetch;",
    "const f = useProxy ? fetch : loopbackFetch;",
    "const f = useProxy\n  ? fetch\n  : loopbackFetch;",
    "const deps = { fetchImpl: fetch };",
    "return fetch;",
    "fetch.call(null, url);",
  ])("bare fetch: %s", (src) => {
    expect(caught(BARE_FETCH, src)).toBe(true);
  });

  it.each([
    "const r = await globalThis.fetch(url);",
    'const f = globalThis["fetch"];',
    "const { fetch: f } = globalThis;",
    "const { fetch } = self;",
    "const r = await globalThis?.fetch(url);",
    'const f = globalThis?.["fetch"];',
    "const r = await global.fetch(url);",
    "const { fetch } = global;",
    "({ fetch: g } = window);",
  ])("global fetch: %s", (src) => {
    expect(caught(GLOBAL_FETCH, src)).toBe(true);
  });

  it.each([
    'import http from "node:http";',
    'import { request } from "https";',
    'const http = await import("node:http");',
    'const m = await import("https");',
    "const m = await import(`node:http`);",
    'const h = require("node:https");',
    'import { type IncomingMessage, request } from "node:http";',
  ])("http import: %s", (src) => {
    expect(caught(HTTP_IMPORT, src)).toBe(true);
  });

  it.each(['const u = await import("undici");', 'import { fetch as f } from "undici";'])(
    "undici import: %s",
    (src) => {
      expect(caught(UNDICI_IMPORT, src)).toBe(true);
    },
  );

  it.each([
    ["a /* inside a line comment", "// see shared/*\nconst r = await fetch(url);\n// end */"],
    ["a /* inside a string", 'const g = "a/*b";\nconst r = await fetch(url);\nconst h = "*/";'],
    ["a /* inside a regex", "const re = /[/*]/;\nconst r = await fetch(url);\nconst x = 1; /* */"],
    ["a // inside a string", 'const u = "http://x";\nconst r = await fetch(u);'],
    ["code inside a template ${}", "const s = `a${await fetch(u)}b`;"],
  ])("the comment scanner does not hide live code: %s", (_label, src) => {
    expect(caught(BARE_FETCH, src)).toBe(true);
  });

  it("the comment scanner does remove real comments", () => {
    expect(caught(BARE_FETCH, "// fetch(url)\n/* fetch(url) */\nconst x = 1;")).toBe(false);
  });

  it.each([
    'import type { Server } from "node:http";',
    'import type {\n  IncomingMessage,\n  Server,\n} from "http";',
    'export type { Server } from "node:https";',
    "const t: typeof fetch = loopbackFetch;",
    "const deps = { fetch: loopbackFetch };",
  ])("exempt: %s", (src) => {
    const s = strip(src);
    expect([...s.matchAll(HTTP_IMPORT)].length + [...s.matchAll(BARE_FETCH)].length).toBe(0);
  });
});
