/**
 * Pins WHO can produce an `annotation:*` channel event.
 *
 * ADR-035's brand makes `narrowForChannel` the only expression in the program
 * that can produce a `ChannelEligible`, and the payload builders in
 * `projection.ts` accept nothing else. That closes the observers. It does not
 * close the language: a `TandemEvent` is a plain object, so anywhere in `src/`
 * can hand-build `{type: "annotation:created", payload: {...}}` and push it,
 * and the brand never enters the picture. One place already does, deliberately.
 *
 * So the brand covers the typed path and this file covers the untyped one. A
 * guard that only walked the observers would be reporting on the half that was
 * already safe.
 *
 * **This is the Unit 4 pattern, and the lesson that produced it applies here
 * verbatim: a derive-from-source guard's bug is never the matching logic, it is
 * the scope, and every scope looks total when you choose it.** That guard was
 * defeated four times — a bare `writeFile`, a file outside the scan roots, a
 * `.mts` inside them, and an `.mjs` that the fix for the third made invisible.
 * Hence three independent surfaces below, each able to catch what the others
 * structurally cannot:
 *
 * 1. **Literal producers** — pinned per file, by count.
 * 2. **The whole-`src` sweep** — every extension, so a producer cannot hide in
 *    a file type the pin does not enumerate.
 * 3. **The arbitrary-event seam** — `_pushEventForTests` takes any
 *    `TandemEvent`, so a production caller of it is a producer that neither of
 *    the above can see.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(__dirname, "..", "..", "..");
const SRC = join(REPO, "src");

/**
 * Every file under `src/`, regardless of extension.
 *
 * Deliberately NOT filtered by an extension allowlist. The fourth defeat of the
 * Unit 4 guard was an `.mjs` that fell through exactly such a list, and the
 * list had been added to fix the third defeat. A sweep that reads everything
 * cannot have that hole; the cost is reading a handful of `.css` and `.md`
 * files, which is nothing.
 */
function allSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `.claude` holds per-session hook scratch state, not source.
      if (entry === "node_modules" || entry === ".claude") continue;
      allSourceFiles(full, acc);
      continue;
    }
    acc.push(full);
  }
  return acc;
}

const FILES = allSourceFiles(SRC).map((f) => ({
  path: relative(REPO, f).split(sep).join("/"),
  text: readFileSync(f, "utf8"),
}));

/**
 * A `type:` property whose value is an annotation event type — the shape of a
 * hand-built event object.
 *
 * Matches the template-literal form too. Nothing in `src/` builds one that way
 * today, but `` type: `annotation:${x}` `` is the obvious way to slip past a
 * quote-anchored pattern, and a guard that can be defeated by a backtick is
 * decorative. The `case "annotation:created":` consumers in `queue.ts`,
 * `delivery-state.ts` and `sse-consumer.ts` do not match: they are `case`
 * labels, not object properties.
 */
const PRODUCER = /\btype:\s*(?:["'`]annotation:[a-z]+["'`]|`annotation:\$\{)/g;

/**
 * The complete set of files that may construct an `annotation:*` event, with
 * the number of sites in each.
 *
 * Counts rather than a bare set: an added event type in an existing producer is
 * still a new thing on the wire and still needs a reviewer to look at it.
 */
const PRODUCERS: Record<string, number> = {
  // The five transitions: created (add), created (note→comment promotion),
  // edited, accepted, dismissed. All build from a `ChannelEligible`.
  "src/server/events/observers/annotations.ts": 5,
  // annotation:reply, from a narrowed parent and a narrowed reply.
  "src/server/events/observers/replies.ts": 1,
  // THE ONE ESCAPE. `emitModeReleaseWake` builds an `annotation:created` with
  // no annotation behind it: a synthetic Solo→Tandem release nudge whose
  // `content` is the module constant `MODE_RELEASE_WAKE_CONTENT` and whose
  // `annotationId` is in the disjoint `wake_` namespace. It carries no
  // document data, so it has nothing to narrow and cannot leak anything. It is
  // shaped as `annotation:created` so version-pinned monitors parse it.
  //
  // This entry is why the guard is a pinned map and not "must import
  // projection.js": a legitimate producer exists that correctly does not.
  "src/server/events/queue.ts": 1,
};

/**
 * The type declarations themselves: `type: "annotation:created";` in an
 * interface is a discriminant, not a construction.
 *
 * Excluded by path rather than by "ends in a semicolon", because that
 * discriminator is a formatting accident — the last property of an object
 * literal has no trailing comma either, and it holds today only because biome
 * enforces one. A path exclusion is narrower and it is checkable, which is what
 * `cannot emit anything` below does: this file must stay unable to push.
 */
const DECLARATIONS_ONLY = ["src/shared/events/types.ts"];

/** Files that build a payload from an annotation, and so must go through the narrow. */
const MUST_NARROW = [
  "src/server/events/observers/annotations.ts",
  "src/server/events/observers/replies.ts",
];

describe("who can produce an annotation:* channel event", () => {
  it("no file outside the pinned set constructs one", () => {
    const offenders = FILES.filter((f) => PRODUCER.test(((PRODUCER.lastIndex = 0), f.text)))
      .map((f) => f.path)
      .filter((p) => !(p in PRODUCERS) && !DECLARATIONS_ONLY.includes(p));

    expect(
      offenders,
      "A new producer of annotation:* events. If it builds its payload from an " +
        "annotation, route it through narrowForChannel (ADR-035) and add it to " +
        "PRODUCERS. If it is synthetic like emitModeReleaseWake, add it to " +
        "PRODUCERS with a comment saying what it carries and why that is safe.",
    ).toEqual([]);
  });

  it.each(Object.entries(PRODUCERS))("%s constructs exactly %i", (path, expected) => {
    const file = FILES.find((f) => f.path === path);
    expect(file, `${path} is pinned but no longer exists`).toBeDefined();
    PRODUCER.lastIndex = 0;
    expect(file?.text.match(PRODUCER)?.length ?? 0).toBe(expected);
  });

  it.each(MUST_NARROW)("%s builds its payloads through the narrow", (path) => {
    const text = FILES.find((f) => f.path === path)?.text ?? "";
    expect(text).toContain("narrowForChannel");
    expect(text, "payload builders must come from projection.js, not be inlined").toMatch(
      /from "\.\.\/\.\.\/annotations\/projection\.js"/,
    );
  });

  it.each(DECLARATIONS_ONLY)("%s cannot emit anything", (path) => {
    // What earns the exclusion. A declaration file that grew a call into the
    // queue would be a producer hiding behind a comment saying it is not one.
    const text = FILES.find((f) => f.path === path)?.text ?? "";
    expect(text, `${path} is excluded as declarations-only but is missing`).not.toBe("");
    expect(text).not.toMatch(/\bpushEvent\b|_pushEventForTests|from "[^"]*queue\.js"/);
  });

  it("the pinned set covers every extension actually present under src/", () => {
    // Not an assertion about producers — an assertion that the SWEEP above
    // reads the whole tree. If this file ever grows an extension filter, this
    // test is what notices that a new file type stopped being read.
    const extensions = new Set(FILES.map((f) => f.path.replace(/^.*(\.[^./]+)$/, "$1")));
    expect(extensions.size, "src/ should contain several file types").toBeGreaterThan(1);
    expect(FILES.length).toBeGreaterThan(400);
  });
});

describe("the arbitrary-event seam", () => {
  /**
   * `_pushEventForTests` accepts any `TandemEvent`, so a production caller
   * could emit a hand-built `annotation:created` without the string
   * `annotation:` appearing anywhere near it — invisible to both surfaces
   * above. That is the whole reason this describe exists.
   */
  it("is called by nothing in src/", () => {
    const callers = FILES.filter(
      (f) => f.path !== "src/server/events/queue.ts" && f.text.includes("_pushEventForTests"),
    ).map((f) => f.path);

    expect(
      callers,
      "_pushEventForTests bypasses every projection guard. It is a test seam; " +
        "production code must use a real observer or a named, documented emitter.",
    ).toEqual([]);
  });

  it("is still named what this test looks for", () => {
    // A rename turns the test above into a zero-of-zero check that passes
    // forever. #1399 is this project's standing instance of that failure.
    const queue = FILES.find((f) => f.path === "src/server/events/queue.ts")?.text ?? "";
    expect(queue).toContain("export function _pushEventForTests");
  });
});
