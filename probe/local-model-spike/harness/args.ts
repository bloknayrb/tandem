/** Minimal `--flag value` / `--flag` parsing for the entry scripts. */

export interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 2) {
      values.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }
  return { values, flags };
}

export function tierArg(raw: string | undefined): "chat" | "editing" | null {
  return raw === "chat" || raw === "editing" ? raw : null;
}
