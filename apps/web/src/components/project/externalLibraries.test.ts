import type { CodeLibraryRoot, CodeServerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { externalLibraryRoots, libraryLocation } from "./externalLibraries";

function server(
  languageId: string,
  libraryRoots: ReadonlyArray<CodeLibraryRoot>,
): CodeServerStatus {
  return { languageId, name: languageId, state: "ready", libraryRoots };
}

const TYPESHED: CodeLibraryRoot = {
  path: "/cache/ty/vendored/typeshed/stdlib",
  label: "typeshed",
  kind: "stubs",
};
const SITE_PACKAGES: CodeLibraryRoot = {
  path: "/work/.venv/lib/python3.13/site-packages",
  label: "site-packages",
  kind: "site-packages",
};
const STDLIB: CodeLibraryRoot = { path: "/usr/lib/python3.13", label: "stdlib", kind: "stdlib" };
const NODE_MODULES: CodeLibraryRoot = {
  path: "/work/node_modules",
  label: "node_modules",
  kind: "node_modules",
};

const pairs = (servers: ReadonlyArray<CodeServerStatus>) =>
  externalLibraryRoots(servers).map((root) => [root.label, root.path]);

describe("externalLibraryRoots", () => {
  it("lists a server's roots in order, with their absolute paths", () => {
    expect(pairs([server("python", [SITE_PACKAGES, STDLIB])])).toEqual([
      ["site-packages", SITE_PACKAGES.path],
      ["stdlib", STDLIB.path],
    ]);
  });

  it.each([
    ["no roots", []],
    ["only stubs", [TYPESHED]],
    ["several stub roots", [TYPESHED, { ...TYPESHED, path: "/cache/other", label: "other" }]],
  ])("adds nothing for a server with %s", (_name, roots) => {
    expect(externalLibraryRoots([server("typescript", roots)])).toEqual([]);
    expect(externalLibraryRoots([])).toEqual([]);
  });

  it("keeps the stubs of a server that has real roots too", () => {
    expect(pairs([server("python", [TYPESHED, SITE_PACKAGES])])).toEqual([
      ["typeshed", TYPESHED.path],
      ["site-packages", SITE_PACKAGES.path],
    ]);
  });

  it("drops a stubs-only server without hiding another server's roots", () => {
    expect(
      pairs([server("python-stubs", [TYPESHED]), server("typescript", [NODE_MODULES])]),
    ).toEqual([["node_modules", NODE_MODULES.path]]);
  });

  it("still lists a path a stubs-only server also had, when a server with real roots has it", () => {
    expect(pairs([server("a", [TYPESHED]), server("b", [SITE_PACKAGES, TYPESHED])])).toEqual([
      ["site-packages", SITE_PACKAGES.path],
      ["typeshed", TYPESHED.path],
    ]);
  });

  it("shows a path from two servers once, under the first one's label", () => {
    expect(
      pairs([
        server("python", [SITE_PACKAGES, STDLIB]),
        server("other", [{ ...STDLIB, label: "Python stdlib" }, NODE_MODULES]),
      ]),
    ).toEqual([
      ["site-packages", SITE_PACKAGES.path],
      ["stdlib", STDLIB.path],
      ["node_modules", NODE_MODULES.path],
    ]);
  });

  it("shows a path repeated within one server once", () => {
    expect(pairs([server("python", [STDLIB, { ...STDLIB, label: "again" }])])).toEqual([
      ["stdlib", STDLIB.path],
    ]);
  });

  it("numbers a repeated label from 2, in the order the roots come", () => {
    const labelled = (path: string) => ({ ...NODE_MODULES, path, label: "node_modules" });
    expect(
      pairs([
        server("typescript", [labelled("/a/node_modules"), labelled("/b/node_modules")]),
        server("other", [labelled("/c/node_modules")]),
      ]).map(([label]) => label),
    ).toEqual(["node_modules", "node_modules (2)", "node_modules (3)"]);
  });

  it("keeps labels unique when a repeat's number is already a label", () => {
    const labelled = (path: string, label: string) => ({ ...STDLIB, path, label });
    const labels = pairs([
      server("python", [
        labelled("/a", "lib"),
        labelled("/b", "lib (2)"),
        labelled("/c", "lib"),
        labelled("/d", "lib (2)"),
      ]),
    ]).map(([label]) => label);

    expect(labels).toEqual(["lib", "lib (2)", "lib (3)", "lib (2) (2)"]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("turns a / in a label into U+2215 so the root stays one node", () => {
    const [root] = externalLibraryRoots([
      server("typescript", [{ ...NODE_MODULES, label: "packages/web/node_modules" }]),
    ]);

    expect(root?.label).toBe("packages∕web∕node_modules");
    expect(root?.label).not.toContain("/");
    expect(root?.path).toBe(NODE_MODULES.path);
  });

  it("numbers labels that only differ by a / once it is replaced", () => {
    const labels = pairs([
      server("typescript", [
        { ...NODE_MODULES, path: "/a", label: "a/b" },
        { ...NODE_MODULES, path: "/b", label: "a∕b" },
      ]),
    ]).map(([label]) => label);

    expect(labels).toEqual(["a∕b", "a∕b (2)"]);
  });

  it("gives a repeated slashed label a number after the replacement", () => {
    const labels = pairs([
      server("typescript", [
        { ...NODE_MODULES, path: "/a", label: "pkg/node_modules" },
        { ...NODE_MODULES, path: "/b", label: "pkg/node_modules" },
      ]),
    ]).map(([label]) => label);

    expect(labels).toEqual(["pkg∕node_modules", "pkg∕node_modules (2)"]);
  });

  it("does not number the labels of a server it skipped", () => {
    const labels = pairs([
      server("python-stubs", [{ ...TYPESHED, label: "stdlib" }]),
      server("python", [STDLIB]),
    ]).map(([label]) => label);

    expect(labels).toEqual(["stdlib"]);
  });
});

describe("libraryLocation", () => {
  const roots = externalLibraryRoots([
    server("python", [SITE_PACKAGES, TYPESHED]),
    server("typescript", [
      { ...NODE_MODULES, label: "packages/web/node_modules" },
      { ...NODE_MODULES, path: "/work/other/node_modules", label: "site-packages" },
    ]),
  ]);

  it.each([
    ["site-packages", SITE_PACKAGES.path, ""],
    ["site-packages/", SITE_PACKAGES.path, ""],
    ["site-packages/stripe", SITE_PACKAGES.path, "stripe"],
    ["site-packages/stripe/", SITE_PACKAGES.path, "stripe"],
    ["site-packages/stripe/api/_invoice.py", SITE_PACKAGES.path, "stripe/api/_invoice.py"],
    ["typeshed/builtins.pyi", TYPESHED.path, "builtins.pyi"],
    ["packages∕web∕node_modules/", NODE_MODULES.path, ""],
    ["packages∕web∕node_modules/react/index.js", NODE_MODULES.path, "react/index.js"],
    ["site-packages (2)/left-pad/", "/work/other/node_modules", "left-pad"],
  ])("maps %j to %s and %j", (treePath, rootPath, relativePath) => {
    const location = libraryLocation(roots, treePath);

    expect(location?.root.path).toBe(rootPath);
    expect(location?.relativePath).toBe(relativePath);
  });

  it.each([
    ["an unknown label", "elsewhere/file.py"],
    ["a label's prefix", "site/stripe"],
    ["a label with more after it", "site-packages-extra/stripe"],
    ["a path in the workspace tree", "src/app.ts"],
    ["the unreplaced label", "packages/web/node_modules/react"],
    ["an empty path", ""],
    ["a lone slash", "/"],
  ])("finds no root for %s", (_name, treePath) => {
    expect(libraryLocation(roots, treePath)).toBeNull();
  });

  it("finds nothing when there are no roots", () => {
    expect(libraryLocation([], "site-packages/stripe")).toBeNull();
  });

  it("round-trips the tree path of a listed entry back to the file on disk", () => {
    const [root] = externalLibraryRoots([
      server("typescript", [{ ...NODE_MODULES, label: "packages/web/node_modules" }]),
    ]);
    const entryPath = "react/index.js";

    const location = libraryLocation([root!], `${root!.label}/${entryPath}`);

    expect(location).toEqual({ root, relativePath: entryPath });
  });
});
