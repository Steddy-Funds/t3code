import { ALL_DIFF_THEME_NAMES } from "../lib/diffRendering";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { DiffWorkerError } from "./DiffWorkerPoolProvider";

// The worker entry reads `self`, which a node test has no use for; the error class does not touch it.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: vi.fn() }));

describe("DiffWorkerError", () => {
  it.each(ALL_DIFF_THEME_NAMES)("accepts the %s theme name", (themeName) => {
    const error = new DiffWorkerError({ operation: "set-render-options", themeName, cause: "x" });
    expect(error.themeName).toBe(themeName);
    expect(error.message).toBe(
      `Diff worker operation set-render-options failed for theme ${themeName}.`,
    );
  });

  it("accepts exactly the names in ALL_DIFF_THEME_NAMES", () => {
    const themeName = Schema.Struct(DiffWorkerError.fields).fields.themeName;
    const decode = Schema.is(themeName);
    for (const name of ALL_DIFF_THEME_NAMES) expect(decode(name), name).toBe(true);
    for (const name of ["material-deep-ocean-2", "github-dark", "", "Pierre-Dark", "t3-light "]) {
      expect(decode(name), name).toBe(false);
    }
  });
});
