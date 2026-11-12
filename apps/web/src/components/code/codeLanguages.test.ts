import type { CodeLibraryRoot, CodeServerStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fileExtension, libraryRootForPath, serverForPath } from "./codeLanguages";

const server = (languageId: string, roots: ReadonlyArray<string> = []): CodeServerStatus => ({
  languageId,
  name: languageId,
  state: "ready",
  libraryRoots: roots.map((path): CodeLibraryRoot => ({
    path,
    label: path,
    kind: "site-packages",
  })),
});

describe("fileExtension", () => {
  it.each([
    ["src/app.ts", "ts"],
    ["src/APP.TSX", "tsx"],
    ["archive.tar.gz", "gz"],
    ["C:\\proj\\main.py", "py"],
    ["a/b.c/readme", ""],
    ["a\\b.c\\readme", ""],
    ["Makefile", ""],
    [".gitignore", ""],
    ["src/.env", ""],
    ["trailing.", ""],
    ["", ""],
  ])("%s -> %j", (path, extension) => {
    expect(fileExtension(path)).toBe(extension);
  });
});

describe("serverForPath", () => {
  const python = server("python");
  const typescript = server("typescript");
  const servers = [python, typescript];

  it.each([
    ["a.py", python],
    ["a.pyi", python],
    ["a.PY", python],
    ["a.ts", typescript],
    ["a.tsx", typescript],
    ["a.mts", typescript],
    ["a.cts", typescript],
    ["a.js", typescript],
    ["a.mjs", typescript],
    ["a.cjs", typescript],
    ["a.jsx", typescript],
  ])("%s", (path, expected) => {
    expect(serverForPath(servers, path)).toBe(expected);
  });

  it.each(["a.rs", "a.md", "Makefile", ".py", "a.json"])("has no server for %s", (path) => {
    expect(serverForPath(servers, path)).toBeNull();
  });

  it("returns null when the language's server is not in the list", () => {
    expect(serverForPath([typescript], "a.py")).toBeNull();
    expect(serverForPath([], "a.ts")).toBeNull();
  });
});

describe("libraryRootForPath", () => {
  it("finds the root an absolute path lies under", () => {
    const servers = [server("python", ["/x/venv/lib/site-packages", "/usr/lib/python3"])];
    expect(libraryRootForPath(servers, "/x/venv/lib/site-packages/pkg/mod.py")?.path).toBe(
      "/x/venv/lib/site-packages",
    );
    expect(libraryRootForPath(servers, "/usr/lib/python3/os.py")?.path).toBe("/usr/lib/python3");
  });

  it("searches every server's roots", () => {
    const servers = [server("python", ["/py"]), server("typescript", ["/proj/node_modules"])];
    expect(libraryRootForPath(servers, "/proj/node_modules/zod/index.ts")?.path).toBe(
      "/proj/node_modules",
    );
  });

  it("is null outside every root, and for no servers or roots", () => {
    expect(libraryRootForPath([server("python", ["/x/venv"])], "/x/src/a.py")).toBeNull();
    expect(libraryRootForPath([server("python")], "/x/a.py")).toBeNull();
    expect(libraryRootForPath([], "/x/a.py")).toBeNull();
  });

  it("matches the root itself", () => {
    expect(libraryRootForPath([server("python", ["/x/venv"])], "/x/venv")?.path).toBe("/x/venv");
  });

  it("does not treat a sibling that shares a prefix as under the root", () => {
    expect(libraryRootForPath([server("python", ["/x/venv"])], "/x/venv2/a.py")).toBeNull();
  });

  it("picks the innermost root when roots nest, whichever comes first", () => {
    const outer = server("typescript", ["/proj/node_modules"]);
    const inner = server("python", ["/proj/node_modules/.venv"]);
    expect(libraryRootForPath([outer, inner], "/proj/node_modules/.venv/a.py")?.path).toBe(
      "/proj/node_modules/.venv",
    );
    expect(libraryRootForPath([inner, outer], "/proj/node_modules/.venv/a.py")?.path).toBe(
      "/proj/node_modules/.venv",
    );
    expect(libraryRootForPath([inner, outer], "/proj/node_modules/zod/a.ts")?.path).toBe(
      "/proj/node_modules",
    );
  });

  it("picks the innermost root among roots of one server too", () => {
    const servers = [server("python", ["/x", "/x/venv/lib", "/x/venv"])];
    expect(libraryRootForPath(servers, "/x/venv/lib/a.py")?.path).toBe("/x/venv/lib");
  });

  it("ignores trailing slashes on the root", () => {
    expect(libraryRootForPath([server("python", ["/x/venv/"])], "/x/venv/a.py")?.path).toBe(
      "/x/venv/",
    );
    expect(libraryRootForPath([server("python", ["/x/venv//"])], "/x/venv2/a.py")).toBeNull();
  });

  it("accepts Windows backslashes on either side", () => {
    const servers = [server("python", ["C:\\proj\\.venv\\Lib\\site-packages"])];
    expect(
      libraryRootForPath(servers, "C:\\proj\\.venv\\Lib\\site-packages\\pkg\\a.py"),
    ).not.toBeNull();
    expect(libraryRootForPath(servers, "C:/proj/.venv/Lib/site-packages/pkg/a.py")).not.toBeNull();
    expect(libraryRootForPath(servers, "C:\\proj\\.venv\\Lib\\site-packages2\\a.py")).toBeNull();
    expect(
      libraryRootForPath([server("python", ["C:/proj/.venv/"])], "C:\\proj\\.venv\\a.py"),
    ).not.toBeNull();
  });
});
