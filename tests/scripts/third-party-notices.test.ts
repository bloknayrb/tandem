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
  findVendoredLicenceFiles,
  hasFullLicenceText,
  licenceCovered,
  licenceFullyCovered,
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
    ["MPL-2.0", "not-allowlisted"],
    ["MIT AND MPL-2.0", "not-allowlisted"], // AND: every term must hold
    ["LGPL-2.1-or-later", "not-allowlisted"],
    ["GPL-2.0+", "not-allowlisted"],
    ["CDLA-Permissive-2.0", "not-allowlisted"], // not on the allowlist, so reported
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

describe("hasFullLicenceText", () => {
  const t = (text: string) => [{ file: "LICENSE", text }];

  it.each([
    // htmlparser2's LICENSE breaks the line between "to" and "deal".
    ["MIT", 'the Software"), to\ndeal in the Software without restriction, including'],
    ["Apache-2.0", "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"],
    ["ISC", "Permission to use, copy, modify, and/or distribute this software for any purpose"],
    ["BSD", "Redistribution and use in source and binary forms, with or without"],
    ["MPL-2.0", "Mozilla Public License Version 2.0"],
    ["Zlib", "This software is provided 'as-is', without any express or implied warranty."],
  ])("accepts a full %s text", (_id, text) => {
    expect(hasFullLicenceText(t(text))).toBe(true);
  });

  it("rejects a pointer file that only names the licences (siphasher's COPYING)", () => {
    expect(
      hasFullLicenceText(
        t(
          "Copyright 2012-2016 The Rust Project Developers.\nLicensed under the Apache License, Version 2.0 or the MIT license, at your option.",
        ),
      ),
    ).toBe(false);
  });

  it("rejects having no text at all", () => {
    expect(hasFullLicenceText([])).toBe(false);
  });

  it("does not read the Unicode licence's shared phrase as MIT", () => {
    const unicode =
      'Permission is hereby granted, free of charge, to any person obtaining a copy of data files and any associated documentation (the "Data Files") or software and any associated documentation (the "Software") to deal in the Data Files or Software without restriction';
    expect(licenceCovered("MIT", t(unicode))).toBe(false);
  });
});

describe("licenceFullyCovered", () => {
  const mit = { file: "a", text: "to deal in the Software without restriction" };
  const apache = {
    file: "b",
    text: "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
  };

  it("needs every OR option, unlike licenceCovered", () => {
    expect(licenceCovered("MIT OR Apache-2.0", [mit])).toBe(true);
    expect(licenceFullyCovered("MIT OR Apache-2.0", [mit])).toBe(false);
    expect(licenceFullyCovered("MIT OR Apache-2.0", [mit, apache])).toBe(true);
  });
});

describe("licenceCovered", () => {
  const MIT = {
    file: "LICENSE",
    text: "Permission is hereby granted ... to deal in the Software without restriction",
  };
  const APACHE = {
    file: "LICENSE-APACHE",
    text: "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION",
  };
  const ZLIB = {
    file: "z",
    text: "This software is provided 'as-is', without any express or implied warranty.",
  };

  it("needs every AND term", () => {
    expect(licenceCovered("(MIT AND Zlib)", [MIT])).toBe(false);
    expect(licenceCovered("(MIT AND Zlib)", [MIT, ZLIB])).toBe(true);
  });

  it("needs one OR option, and slash means OR", () => {
    expect(licenceCovered("MIT OR Apache-2.0", [APACHE])).toBe(true);
    expect(licenceCovered("MIT/Apache-2.0", [MIT])).toBe(true);
  });

  it("is not satisfied by a different licence's text", () => {
    expect(licenceCovered("Apache-2.0", [MIT])).toBe(false);
  });

  it("ignores vendored texts", () => {
    expect(licenceCovered("MIT", [{ ...MIT, vendored: true }])).toBe(false);
  });

  it("accepts any full text for an id it has no family for, and none for nothing", () => {
    expect(licenceCovered("LGPL-2.1-or-later", [MIT])).toBe(true);
    expect(licenceCovered("MIT", [])).toBe(false);
  });

  it("licenceFullyCovered never counts an unknown id as reproduced", () => {
    expect(licenceFullyCovered("MIT OR LGPL-2.1-only", [MIT])).toBe(false);
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
  writeFileSync(join(pkg, "license_header.js"), "code that matches the name pattern"); // jszip's case
  writeFileSync(join(pkg, "UNLICENSE"), "an Unlicense option");
  writeFileSync(join(pkg, "build", "THIRD-PARTY-LICENSES.txt"), "vendored");
  writeFileSync(join(pkg, "LICENSE-THIRD-PARTY"), "vendored too");
  mkdirSync(join(pkg, "src", "spin"), { recursive: true });
  writeFileSync(join(pkg, "src", "spin", "LICENSE"), "a vendored crate's licence");
  writeFileSync(join(pkg, "node_modules", "dep", "THIRD-PARTY-LICENSES.txt"), "not ours");

  it("reads only licence-shaped files, sorted, with text normalised", () => {
    const files = readLicenceFiles(pkg);
    expect(files.map((f) => f.file)).toEqual([
      "LICENSE",
      "LICENSE-THIRD-PARTY",
      "NOTICE.md",
      "UNLICENSE",
      "license-apache-2.0",
    ]);
    expect(files[0].text).toBe("MIT License\n\nCopyright (c) Someone");
  });

  it("finds vendored licence files: aggregates, a third-party root file, anything below the root; never node_modules", () => {
    expect(findVendoredLicenceFiles(pkg)).toEqual([
      "LICENSE-THIRD-PARTY",
      "build/THIRD-PARTY-LICENSES.txt",
      "src/spin/LICENSE",
    ]);
  });

  it("readNpmPackage reproduces vendored files but marks them, so they never count as the package's own", () => {
    const p = readNpmPackage(pkg);
    expect(p).toMatchObject({ name: "fixture", version: "1.2.3", license: "MIT" });
    const vendored = p.texts.filter((t) => "vendored" in t && t.vendored).map((t) => t.file);
    expect(vendored).toEqual([
      "LICENSE-THIRD-PARTY",
      "build/THIRD-PARTY-LICENSES.txt",
      "src/spin/LICENSE",
    ]);
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
