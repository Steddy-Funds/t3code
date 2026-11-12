// @effect-diagnostics nodeBuiltinImport:off - Lists tracked files with the real git CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const MODULE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// macOS and Windows disks ignore case, so `./Foo` finds `foo.ts` before `Foo.tsx` there.
it("has no two source modules whose paths differ only by letter case", () => {
  const tracked = NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: NodePath.join(import.meta.dirname, ".."),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stemsByFoldedStem = new Map<string, Set<string>>();
  for (const file of tracked.split("\0")) {
    if (!MODULE_EXTENSION.test(file) || file.startsWith(".repos/")) continue;
    const stem = file.replace(MODULE_EXTENSION, "");
    const folded = stem.toLowerCase();
    stemsByFoldedStem.set(folded, (stemsByFoldedStem.get(folded) ?? new Set()).add(stem));
  }

  const collisions = [...stemsByFoldedStem.values()]
    .filter((stems) => stems.size > 1)
    .map((stems) => [...stems].sort());
  expect(collisions).toEqual([]);
});
