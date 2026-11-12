import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";
import {
  activatedFiles,
  RECENT_FILE_THREADS,
  RECENT_FILES_PER_THREAD,
  recentFileList,
  withRecentFile,
} from "./codeSymbols";

const file = (path: string): RightPanelSurface => ({
  id: `file:${path}`,
  kind: "file",
  relativePath: path,
  revealLine: null,
  revealRequestId: 0,
});
const attachment = (name: string): RightPanelSurface => ({
  id: `attachment:${name}`,
  kind: "file",
  relativePath: name,
  revealLine: null,
  revealRequestId: 0,
});
const terminal: RightPanelSurface = {
  id: "terminal:t1",
  kind: "terminal",
  resourceId: "t1",
  terminalIds: ["t1"],
  activeTerminalId: "t1",
};

function panel(
  surfaces: ReadonlyArray<RightPanelSurface>,
  active: RightPanelSurface | null,
  isOpen = true,
): ThreadRightPanelState {
  return { isOpen, activeSurfaceId: active?.id ?? null, surfaces: [...surfaces] };
}

describe("withRecentFile", () => {
  it("moves a reopened file to the front without repeating it", () => {
    let state = withRecentFile({}, "t", "a.ts");
    state = withRecentFile(state, "t", "b.ts");
    state = withRecentFile(state, "t", "a.ts");
    expect(state).toEqual({ t: ["a.ts", "b.ts"] });
  });

  it("keeps each thread's list apart and caps its length", () => {
    let state = withRecentFile({}, "other", "z.ts");
    for (let index = 0; index <= RECENT_FILES_PER_THREAD; index += 1) {
      state = withRecentFile(state, "t", `${index}.ts`);
    }
    expect(state.other).toEqual(["z.ts"]);
    expect(state.t).toHaveLength(RECENT_FILES_PER_THREAD);
    expect(state.t?.[0]).toBe(`${RECENT_FILES_PER_THREAD}.ts`);
  });

  it("drops the thread used least recently once too many have lists", () => {
    let state = {};
    for (let index = 0; index < RECENT_FILE_THREADS; index += 1) {
      state = withRecentFile(state, `t${index}`, "a.ts");
    }
    state = withRecentFile(state, "t0", "b.ts");
    state = withRecentFile(state, "new", "a.ts");
    expect(Object.keys(state)).toHaveLength(RECENT_FILE_THREADS);
    expect(state).not.toHaveProperty("t1");
    expect(state).toHaveProperty("t0");
  });
});

describe("activatedFiles", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");

  it("records a file tab that became active, and nothing else", () => {
    const before = { t: panel([a, terminal], terminal), u: panel([a], a) };
    expect(
      activatedFiles(
        { t: panel([a, terminal], a), u: { ...panel([a], a), isOpen: false } },
        before,
      ),
    ).toEqual([{ threadKey: "t", path: "src/a.ts" }]);
    expect(activatedFiles({ t: panel([a, b, terminal], terminal) }, before)).toEqual([]);
    expect(
      activatedFiles({ t: panel([attachment("shot.png")], attachment("shot.png")) }, {}),
    ).toEqual([]);
  });

  it("records the first file of a thread with no panel before", () => {
    expect(activatedFiles({ t: panel([b], b) }, {})).toEqual([
      { threadKey: "t", path: "src/b.ts" },
    ]);
  });
});

describe("recentFileList", () => {
  const a = file("a.ts");
  const b = file("b.ts");
  const c = file("c.ts");

  it("puts the file to go back to first, leaving out the one on screen", () => {
    expect(recentFileList(["b.ts", "a.ts"], panel([a, b], b))).toEqual(["a.ts"]);
  });

  it("adds open tabs never recorded after the recorded ones", () => {
    expect(
      recentFileList(["a.ts"], panel([c, a, terminal, attachment("x.png")], terminal)),
    ).toEqual(["a.ts", "c.ts"]);
  });

  it("keeps the shown file when the panel is closed", () => {
    expect(recentFileList(["b.ts", "a.ts"], panel([a, b], b, false))).toEqual(["b.ts", "a.ts"]);
    expect(recentFileList(["a.ts"], undefined)).toEqual(["a.ts"]);
  });
});
