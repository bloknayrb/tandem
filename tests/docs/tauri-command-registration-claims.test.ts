import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the two Tauri registration sites that **nothing else can fail on**.
 *
 * `tauri::generate_handler![...]` in `src-tauri/src/lib.rs` is the only thing
 * that makes a `#[tauri::command]` reachable from the WebView, and
 * `.on_menu_event(...)` is the only thing that routes a native menu click back
 * to it. Both are plain call arguments: deleting a name from the handler list,
 * or pointing the menu-event registration at something else, **compiles
 * cleanly and leaves the entire Rust suite green**. The command simply stops
 * existing at runtime and `invoke()` rejects in the browser, where no Rust test
 * is looking. Verified by mutation, not assumed.
 *
 * That gap has always existed. Unit 11b is what made it worth closing here:
 * moving the context-menu cluster into its own module turned three bare
 * identifiers in the handler list into module-qualified paths, and a fourth
 * into `context_menu::forward_context_menu_event` — edits to exactly the two
 * lines whose breakage is invisible. Units 11c–11f do the same thing four more
 * times.
 *
 * **Both sides are derived from source**, never listed here. A test seeded with
 * the command names someone remembered would only confirm the list against
 * itself, which is the failure this file exists to prevent.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LIB_RS = join(REPO_ROOT, "src-tauri", "src", "lib.rs");
const CLIENT_SRC = join(REPO_ROOT, "src", "client");

/** Drop `//` and block comments, so a name merely discussed in prose is not read as a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The command names registered with Tauri, as the IPC layer sees them.
 *
 * A module-qualified entry (`context_menu::show_context_menu`) registers under
 * its **last segment** — the bare function identifier — which is why moving a
 * command between modules does not change the wire name. Taking the last
 * segment here is not a convenience; it is the same rule the macro applies.
 */
function registeredCommands(): string[] {
  const lib = stripComments(readFileSync(LIB_RS, "utf8"));
  const block = lib.match(/tauri::generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error("generate_handler! block not found in lib.rs");
  return block[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split("::").pop() as string);
}

function clientFiles(): Array<{ rel: string; text: string }> {
  return readdirSync(CLIENT_SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|svelte)$/.test(e.name))
    .map((e) => {
      const abs = join(e.parentPath, e.name);
      return {
        rel: abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/"),
        text: readFileSync(abs, "utf8"),
      };
    });
}

/**
 * Every command the client actually invokes, plus every call this scan could
 * not resolve.
 *
 * Three real call sites pass a module constant rather than a literal
 * (`invoke<string | null>(TAKE_COMMAND)`), so a literal-only scan would miss
 * them and quietly check less. Same-file `const NAME = "literal"` bindings are
 * resolved; anything still unresolved is **returned rather than dropped**, and
 * the test below fails on it. A blind spot that reports itself is a gap; one
 * that does not is a false pass.
 */
function invokedCommands(): { names: Set<string>; unresolved: string[] } {
  const names = new Set<string>();
  const unresolved: string[] = [];
  for (const { rel, text } of clientFiles()) {
    const src = stripComments(text);
    const consts = new Map<string, string>();
    for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*"([a-z_0-9]+)"/g)) {
      consts.set(m[1], m[2]);
    }
    for (const m of src.matchAll(/\binvoke(?:<[^>]*>)?\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      const literal = arg.match(/^"([a-z_0-9]+)"$/);
      if (literal) {
        names.add(literal[1]);
        continue;
      }
      const resolved = consts.get(arg);
      if (resolved) {
        names.add(resolved);
        continue;
      }
      unresolved.push(`${rel}: invoke(${arg})`);
    }
  }
  return { names, unresolved };
}

describe("Tauri command registration, which only source-scanning can pin", () => {
  it("derives a real handler list, not an empty one", () => {
    // The control on the Rust half. The parity check below is a loop over the
    // client's names testing membership in this list — but a mis-parsed or
    // empty list would turn that into "nothing is registered", which fails
    // loudly, while a list that silently grew to include every identifier in
    // the file would make it pass vacuously. Pin both size and content.
    const registered = registeredCommands();
    expect(registered.length, "the generate_handler! parse found almost nothing").toBeGreaterThan(
      20,
    );
    expect(registered.length, "the parse swallowed more than the handler list").toBeLessThan(80);
    expect(registered).toContain("show_context_menu");
    expect(registered).toContain("keychain_get");
    expect(
      registered,
      "a module-qualified entry must register under its bare last segment",
    ).not.toContain("context_menu::show_context_menu");
  });

  it("derives a real invoke set, and resolves every call it finds", () => {
    // The control on the client half, and the anti-blind-spot check. Zero
    // invoked commands satisfies the parity assertion perfectly.
    const { names, unresolved } = invokedCommands();
    expect(names.size, "the invoke() scan found almost nothing").toBeGreaterThan(15);
    expect(names).toContain("show_tab_context_menu");
    expect(
      unresolved,
      "an invoke() call whose command name this scan could not resolve. It is not " +
        "checked against the handler list, so it is a hole in this gate — resolve it " +
        "here rather than letting the scan quietly cover less than it appears to.",
    ).toEqual([]);
  });

  it("registers every command the client invokes", () => {
    const registered = new Set(registeredCommands());
    const { names } = invokedCommands();
    for (const name of [...names].sort()) {
      expect(
        registered.has(name),
        `The client invokes "${name}" but tauri::generate_handler! does not register it. ` +
          `Nothing else catches this: the Rust side compiles and its whole suite passes, ` +
          `and the failure surfaces only as a rejected invoke() in the WebView at runtime.`,
      ).toBe(true);
    }
  });

  it("routes native menu clicks to the context-menu forwarder", () => {
    // `.on_menu_event` is registered once, app-level, and is the only path from
    // a native menu click back to the WebView. Replacing it with a no-op is
    // green everywhere. Anchored on the registration call rather than on the
    // function's own text, because the function existing says nothing about
    // whether anything calls it.
    //
    // Honest limit: this keys on the argument being the forwarder itself. A
    // future change that legitimately routes through a wrapper would fail here
    // and need this assertion updated — which is the intended cost, but it is
    // a text-shape check and a determined indirection defeats it.
    const lib = stripComments(readFileSync(LIB_RS, "utf8"));
    expect(
      /\.on_menu_event\(\s*(?:crate::)?context_menu::forward_context_menu_event\s*\)/.test(lib),
      "lib.rs must pass context_menu::forward_context_menu_event to .on_menu_event. " +
        "Without it every native context-menu click is silently dropped — the menu " +
        "opens, items are clickable, and nothing happens.",
    ).toBe(true);
  });
});
