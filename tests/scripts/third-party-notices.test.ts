/**
 * Unit tests for scripts/third-party-notices/lib.mjs — the pure half of the
 * generator that builds THIRD_PARTY_NOTICES.txt for the npm tarball and the
 * desktop bundle. The I/O half (reading dist/, cargo metadata, the Node
 * LICENSE) fails closed at build time; tests/build/third-party-notices-wiring.test.ts
 * pins where it is wired in.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  classifyLicence,
  findBundledNoticeFiles,
  packageRootOf,
  readLicenceFiles,
  readNpmPackage,
  renderSection,
} from "../../scripts/third-party-notices/lib.mjs";

const tmp = mkdtempSync(join(tmpdir(), "tandem-notices-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("packageRootOf", () => {
  it("takes the LAST node_modules segment, so a nested copy wins over its parent", () => {
    expect(packageRootOf("/r/node_modules/a/node_modules/b/dist/x.js")).toEqual({
      root: "/r/node_modules/a/node_modules/b",
      name: "b",
    });
  });

  it("keeps the scope of a scoped package", () => {
    expect(packageRootOf("/r/node_modules/@tiptap/core/dist/index.js")).toEqual({
      root: "/r/node_modules/@tiptap/core",
      name: "@tiptap/core",
    });
  });

  it("normalises Windows separators", () => {
    expect(packageRootOf("C:\\r\\node_modules\\yjs\\dist\\yjs.mjs")?.name).toBe("yjs");
  });

  it("returns null for first-party source", () => {
    expect(packageRootOf("/r/src/server/index.ts")).toBeNull();
  });
});

describe("classifyLicence", () => {
  it.each([
    ["MIT", "permissive"],
    ["MIT/Apache-2.0", "permissive"], // old crates.io slash syntax means OR
    ["Unlicense/MIT", "permissive"],
    ["Apache-2.0 AND ISC", "permissive"],
    ["(Apache-2.0 OR MIT) AND BSD-3-Clause", "permissive"],
    ["Apache-2.0 WITH LLVM-exception", "permissive"],
    ["(MIT OR GPL-3.0-or-later)", "permissive-option"],
    ["MIT OR Apache-2.0 OR LGPL-2.1-or-later", "permissive-option"],
    ["MPL-2.0", "non-permissive"],
    ["MIT AND MPL-2.0", "non-permissive"], // AND: every term must hold
    ["LGPL-2.1-or-later", "non-permissive"],
    ["GPL-2.0+", "non-permissive"],
    ["CDLA-Permissive-2.0", "non-permissive"], // not on the allowlist, so reported
    ["UNKNOWN", "unknown"],
    ["UNLICENSED", "unknown"],
    ["SEE LICENSE IN LICENSE.md", "unknown"],
    ["", "unknown"],
    ["MIT OR", "unknown"], // malformed: never guessed permissive
    ["(MIT", "unknown"],
  ])("%s → %s", (expr, expected) => {
    expect(classifyLicence(expr)).toBe(expected);
  });
});

describe("licence file discovery", () => {
  const pkg = join(tmp, "node_modules", "fixture");
  mkdirSync(join(pkg, "LICENSE-dir-not-file"), { recursive: true });
  mkdirSync(join(pkg, "build"), { recursive: true });
  mkdirSync(join(pkg, "node_modules", "dep"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.2.3", license: "MIT" }),
  );
  writeFileSync(join(pkg, "LICENSE"), "\uFEFFMIT License\r\n\r\nCopyright (c) Someone   \r\n");
  writeFileSync(join(pkg, "license-apache-2.0"), "Apache License");
  writeFileSync(join(pkg, "NOTICE.md"), "notice");
  writeFileSync(join(pkg, "README.md"), "not a licence");
  writeFileSync(join(pkg, "licenseChecker.js"), "code, not a licence");
  writeFileSync(join(pkg, "build", "THIRD-PARTY-LICENSES.txt"), "vendored");
  writeFileSync(join(pkg, "node_modules", "dep", "THIRD-PARTY-LICENSES.txt"), "not ours");

  it("reads only licence-shaped files, sorted, with text normalised", () => {
    const files = readLicenceFiles(pkg);
    expect(files.map((f) => f.file)).toEqual(["LICENSE", "NOTICE.md", "license-apache-2.0"]);
    expect(files[0].text).toBe("MIT License\n\nCopyright (c) Someone");
  });

  it("finds a vendored-code notices file below the root but not inside node_modules", () => {
    expect(findBundledNoticeFiles(pkg)).toEqual(["build/THIRD-PARTY-LICENSES.txt"]);
  });

  it("readNpmPackage carries both", () => {
    const p = readNpmPackage(pkg);
    expect(p).toMatchObject({ name: "fixture", version: "1.2.3", license: "MIT" });
    expect(p.texts.map((t: { file: string }) => t.file)).toContain(
      "build/THIRD-PARTY-LICENSES.txt",
    );
  });

  it("reports a package with no licence field as UNKNOWN rather than dropping it", () => {
    const bare = join(tmp, "node_modules", "bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "bare", version: "0.0.1" }));
    expect(readNpmPackage(bare)).toMatchObject({ license: "UNKNOWN", texts: [] });
  });
});

describe("renderSection", () => {
  const mit = { file: "LICENSE", text: "MIT text" };
  const apache = { file: "LICENSE", text: "Apache text" };
  const components = [
    {
      name: "zeta",
      version: "1.0.0",
      license: "MIT",
      includedIn: ["server"],
      repository: "",
      texts: [mit],
    },
    {
      name: "alpha",
      version: "2.0.0",
      license: "Apache-2.0",
      includedIn: ["client"],
      repository: "",
      texts: [apache],
    },
    {
      name: "beta",
      version: "1.0.0",
      license: "MIT",
      includedIn: ["client", "server"],
      repository: "",
      texts: [mit],
    },
  ];

  it("prints each distinct text once, naming every component that uses it", () => {
    const out = renderSection("npm", "Packages", components);
    expect(out.match(/^MIT text$/gm)).toHaveLength(1);
    expect(out).toContain("[npm text 2] used by: beta@1.0.0, zeta@1.0.0");
  });

  it("is independent of input order", () => {
    expect(renderSection("npm", "Packages", [...components].reverse())).toBe(
      renderSection("npm", "Packages", components),
    );
  });

  it("sorts by code unit, not locale", () => {
    const out = renderSection("npm", "P", [
      { name: "b", version: "1", license: "MIT", includedIn: [], repository: "", texts: [mit] },
      { name: "B", version: "1", license: "MIT", includedIn: [], repository: "", texts: [mit] },
    ]);
    expect(out.indexOf("B@1")).toBeLessThan(out.indexOf("b@1"));
  });
});
