import { CodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import { CodeIntelError, type CodeLocation, type CodeRange } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  type CodeIntelOutcome,
  codeIntelOutcome,
  codeIntelStep,
  definitionExcerpt,
  fencedCode,
  filterLocations,
  groupLocationsByFile,
  isLineUnchanged,
  isOwnDeclaration,
  parseGoToLine,
  textMatchLocations,
  wordAt,
  wordAtPosition,
} from "./codeNavigationModel";

const location = (path: string, line = 0, start = 0, end = 3, lineText?: string): CodeLocation => ({
  path,
  external: false,
  range: { start: { line, character: start }, end: { line, character: end } },
  ...(lineText === undefined ? {} : { lineText }),
});

describe("wordAt", () => {
  it("finds the whole word around an index inside it", () => {
    expect(wordAt("let fooBar = 1", 6)).toEqual({ start: 4, end: 10 });
    expect(wordAt("let fooBar = 1", 4)).toEqual({ start: 4, end: 10 });
    expect(wordAt("let fooBar = 1", 9)).toEqual({ start: 4, end: 10 });
  });

  it("treats Unicode letters, digits, underscore and dollar as word characters", () => {
    expect(wordAt("naïve_变量$1 x", 2)).toEqual({ start: 0, end: 10 });
    expect(wordAt("$el", 0)).toEqual({ start: 0, end: 3 });
    expect(wordAt("_private", 3)).toEqual({ start: 0, end: 8 });
  });

  it("is null on punctuation, whitespace, and out-of-range indexes", () => {
    expect(wordAt("a.b", 1)).toBeNull();
    expect(wordAt("a b", 1)).toBeNull();
    expect(wordAt("abc", -1)).toBeNull();
    expect(wordAt("abc", 3)).toBeNull();
    expect(wordAt("", 0)).toBeNull();
  });

  it("stops at punctuation on both sides", () => {
    expect(wordAt("a.bc-d", 3)).toEqual({ start: 2, end: 4 });
  });
});

describe("wordAtPosition", () => {
  const text = "import foo from 'bar'\nconst x = foo.baz;\n";

  it("returns the word at a caret inside it, on any line", () => {
    expect(wordAtPosition(text, { line: 0, character: 8 })).toBe("foo");
    expect(wordAtPosition(text, { line: 1, character: 12 })).toBe("foo");
    expect(wordAtPosition(text, { line: 1, character: 16 })).toBe("baz");
  });

  it("finds a word the caret sits just after", () => {
    expect(wordAtPosition(text, { line: 0, character: 6 })).toBe("import");
    expect(wordAtPosition(text, { line: 1, character: 13 })).toBe("foo");
  });

  it("is null between two non-word characters", () => {
    expect(wordAtPosition("a  b", { line: 0, character: 2 })).toBeNull();
    expect(wordAtPosition("( )", { line: 0, character: 1 })).toBeNull();
  });

  it("is null at the start of a line that starts with punctuation", () => {
    expect(wordAtPosition("  foo", { line: 0, character: 0 })).toBeNull();
  });

  it("handles CRLF lines without the carriage return counting as text", () => {
    const crlf = "alpha\r\nbeta\r\n";
    expect(wordAtPosition(crlf, { line: 0, character: 5 })).toBe("alpha");
    expect(wordAtPosition(crlf, { line: 1, character: 2 })).toBe("beta");
    expect(wordAtPosition(crlf, { line: 1, character: 4 })).toBe("beta");
  });

  it("is null for a line past the end", () => {
    expect(wordAtPosition("one\ntwo", { line: 2, character: 0 })).toBeNull();
    expect(wordAtPosition("", { line: 1, character: 0 })).toBeNull();
  });

  it("reads the last line without a trailing newline", () => {
    expect(wordAtPosition("one\ntwo", { line: 1, character: 1 })).toBe("two");
  });

  it("is null on an empty line", () => {
    expect(wordAtPosition("a\n\nb", { line: 1, character: 0 })).toBeNull();
  });

  it("is null for a column past the line's end beyond the caret-after case", () => {
    expect(wordAtPosition("abc", { line: 0, character: 10 })).toBeNull();
  });
});

describe("isLineUnchanged", () => {
  const before = "import a\nconst x = foo();\nreturn x;";

  it("is true when the line reads the same, including with no edits at all", () => {
    expect(isLineUnchanged(before, before, 1)).toBe(true);
    expect(isLineUnchanged(before, before, 0)).toBe(true);
    expect(isLineUnchanged(before, before, 2)).toBe(true);
  });

  it("is false when lines were inserted above", () => {
    expect(isLineUnchanged(before, `// new\n${before}`, 1)).toBe(false);
  });

  it("is false when lines were removed above", () => {
    expect(isLineUnchanged(before, before.split("\n").slice(1).join("\n"), 1)).toBe(false);
  });

  it("is true for an edit below the line", () => {
    expect(isLineUnchanged(before, `${before}\nmore();`, 1)).toBe(true);
    expect(isLineUnchanged(before, before.replace("return x;", "return y;"), 1)).toBe(true);
  });

  it("is false for an edit on the line itself", () => {
    expect(isLineUnchanged(before, before.replace("foo()", "bar()"), 1)).toBe(false);
    expect(isLineUnchanged(before, before.replace("const x", "const  x"), 1)).toBe(false);
  });

  it("is false for a line past the end of either text", () => {
    expect(isLineUnchanged(before, "import a", 1)).toBe(false);
    expect(isLineUnchanged("import a", before, 1)).toBe(false);
    expect(isLineUnchanged(before, before, 3)).toBe(false);
    expect(isLineUnchanged("", "", 1)).toBe(false);
  });

  it("treats CRLF and LF endings of the same line as equal, both ways", () => {
    expect(isLineUnchanged(before, before.replaceAll("\n", "\r\n"), 1)).toBe(true);
    expect(isLineUnchanged(before.replaceAll("\n", "\r\n"), before, 1)).toBe(true);
    expect(isLineUnchanged(before.replaceAll("\n", "\r\n"), before, 2)).toBe(true);
  });

  it("is true for an existing empty line that stays empty, false once it has text", () => {
    expect(isLineUnchanged("a\n\nb", "x\n\nb", 1)).toBe(true);
    expect(isLineUnchanged("a\n\nb", "a\nz\nb", 1)).toBe(false);
  });
});

describe("isOwnDeclaration", () => {
  const cwd = "/proj";
  const declaration = location("src/a.ts", 4, 6, 10);

  it("matches a position inside the declaration's range", () => {
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 4, character: 7 })).toBe(true);
  });

  it("includes both ends of the range", () => {
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 4, character: 6 })).toBe(true);
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 4, character: 10 })).toBe(true);
  });

  it("does not match just outside the range", () => {
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 4, character: 5 })).toBe(false);
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 4, character: 11 })).toBe(
      false,
    );
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 3, character: 7 })).toBe(false);
    expect(isOwnDeclaration([declaration], "src/a.ts", cwd, { line: 5, character: 7 })).toBe(false);
  });

  it("handles a multi-line range", () => {
    const block: CodeLocation = {
      path: "src/a.ts",
      external: false,
      range: { start: { line: 2, character: 8 }, end: { line: 6, character: 1 } },
    };
    expect(isOwnDeclaration([block], "src/a.ts", cwd, { line: 4, character: 99 })).toBe(true);
    expect(isOwnDeclaration([block], "src/a.ts", cwd, { line: 2, character: 7 })).toBe(false);
    expect(isOwnDeclaration([block], "src/a.ts", cwd, { line: 6, character: 2 })).toBe(false);
  });

  it("matches a relative and an absolute path to the same file", () => {
    expect(isOwnDeclaration([declaration], "/proj/src/a.ts", cwd, { line: 4, character: 7 })).toBe(
      true,
    );
    const absolute = location("/proj/src/a.ts", 4, 6, 10);
    expect(isOwnDeclaration([absolute], "src/a.ts", cwd, { line: 4, character: 7 })).toBe(true);
  });

  it("does not match a different file", () => {
    expect(isOwnDeclaration([declaration], "src/b.ts", cwd, { line: 4, character: 7 })).toBe(false);
    expect(isOwnDeclaration([declaration], "/other/src/a.ts", cwd, { line: 4, character: 7 })).toBe(
      false,
    );
  });

  it("matches if any of several locations holds the position, and not for none", () => {
    const locations = [location("src/b.ts", 1, 0, 3), declaration];
    expect(isOwnDeclaration(locations, "src/a.ts", cwd, { line: 4, character: 8 })).toBe(true);
    expect(isOwnDeclaration([], "src/a.ts", cwd, { line: 4, character: 8 })).toBe(false);
  });
});

describe("groupLocationsByFile", () => {
  it("groups by path in first-seen order, keeping each group's order", () => {
    const b1 = location("b.ts", 1);
    const a1 = location("a.ts", 2);
    const b2 = location("b.ts", 3);
    const c1 = location("c.ts", 4);
    const a2 = location("a.ts", 5);

    const groups = groupLocationsByFile([b1, a1, b2, c1, a2]);

    expect(groups.map((group) => group.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
    expect(groups[0]?.locations).toEqual([b1, b2]);
    expect(groups[1]?.locations).toEqual([a1, a2]);
    expect(groups[2]?.locations).toEqual([c1]);
  });

  it("is empty for no locations", () => {
    expect(groupLocationsByFile([])).toEqual([]);
  });
});

describe("filterLocations", () => {
  const locations = [
    location("src/Alpha.ts", 0, 0, 1, "export const Widget = 1"),
    location("src/beta.ts", 1, 0, 1, "widget.render()"),
    location("lib/gamma.ts", 2, 0, 1),
  ];

  it("keeps everything for a blank query", () => {
    expect(filterLocations(locations, "")).toBe(locations);
    expect(filterLocations(locations, "   ")).toBe(locations);
  });

  it("matches the path, case-insensitively", () => {
    expect(filterLocations(locations, "ALPHA")).toEqual([locations[0]]);
    expect(filterLocations(locations, "lib/")).toEqual([locations[2]]);
  });

  it("matches the line text, case-insensitively", () => {
    expect(filterLocations(locations, "widget")).toEqual([locations[0], locations[1]]);
    expect(filterLocations(locations, "RENDER")).toEqual([locations[1]]);
  });

  it("trims the query and tolerates a location with no line text", () => {
    expect(filterLocations(locations, "  gamma ")).toEqual([locations[2]]);
    expect(filterLocations(locations, "render")).not.toContain(locations[2]);
  });

  it("returns nothing when neither matches", () => {
    expect(filterLocations(locations, "zzz")).toEqual([]);
  });
});

describe("textMatchLocations", () => {
  it("turns 1-based search lines into 0-based ranges", () => {
    expect(
      textMatchLocations([
        {
          path: "a.ts",
          lineNumber: 1,
          lineContent: "foo bar",
          matchRanges: [{ start: 4, end: 7 }],
        },
      ]),
    ).toEqual([
      {
        path: "a.ts",
        external: false,
        lineText: "foo bar",
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
      },
    ]);
  });

  it("emits one location per match range, in order", () => {
    const result = textMatchLocations([
      {
        path: "a.ts",
        lineNumber: 3,
        lineContent: "foo foo",
        matchRanges: [
          { start: 0, end: 3 },
          { start: 4, end: 7 },
        ],
      },
      { path: "b.ts", lineNumber: 10, lineContent: "foo", matchRanges: [{ start: 0, end: 3 }] },
    ]);

    expect(
      result.map((item) => [item.path, item.range.start.line, item.range.start.character]),
    ).toEqual([
      ["a.ts", 2, 0],
      ["a.ts", 2, 4],
      ["b.ts", 9, 0],
    ]);
    expect(result.every((item) => item.lineText !== undefined && !item.external)).toBe(true);
  });

  it("drops a match with no ranges, and handles no matches", () => {
    expect(
      textMatchLocations([{ path: "a.ts", lineNumber: 1, lineContent: "x", matchRanges: [] }]),
    ).toEqual([]);
    expect(textMatchLocations([])).toEqual([]);
  });
});

describe("definitionExcerpt", () => {
  const range = (line: number): CodeRange => ({
    start: { line, character: 0 },
    end: { line, character: 1 },
  });

  it("starts at the declaration's line", () => {
    expect(definitionExcerpt("a\nb\nc\nd", range(2))).toBe("c\nd");
  });

  it("takes at most 20 lines", () => {
    const contents = Array.from({ length: 50 }, (_, index) => `line${index}`).join("\n");
    const lines = definitionExcerpt(contents, range(5)).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("line5");
    expect(lines.at(-1)).toBe("line24");
  });

  it("trims trailing blank lines, including whitespace-only ones", () => {
    expect(definitionExcerpt("def f():\n  pass\n\n  \n\n", range(0))).toBe("def f():\n  pass");
  });

  it("trims blank lines that fall inside the 20-line window's tail", () => {
    const contents = ["a", ...Array.from({ length: 30 }, () => "")].join("\n");
    expect(definitionExcerpt(contents, range(0))).toBe("a");
  });

  it("keeps blank lines between code", () => {
    expect(definitionExcerpt("a\n\nb\n", range(0))).toBe("a\n\nb");
  });

  it("splits CRLF without leaving carriage returns", () => {
    expect(definitionExcerpt("a\r\nb\r\n\r\n", range(0))).toBe("a\nb");
  });

  it("returns one empty line, not nothing, when only blanks remain", () => {
    expect(definitionExcerpt("a\n\n\n", range(1))).toBe("");
  });

  it("is empty past the end of the file", () => {
    expect(definitionExcerpt("a\nb", range(9))).toBe("");
  });
});

describe("fencedCode", () => {
  it("uses a three-backtick fence and the file's language", () => {
    expect(fencedCode("const a = 1;", "src/a.tsx")).toBe("```tsx\nconst a = 1;\n```");
  });

  it("outgrows the longest backtick run inside the code", () => {
    expect(fencedCode("```\ninner\n```", "a.md")).toBe("````md\n```\ninner\n```\n````");
    expect(fencedCode("`` ````` ``", "a.js")).toBe("``````js\n`` ````` ``\n``````");
  });

  it("keeps three backticks for runs shorter than three", () => {
    expect(fencedCode("`a` ``b``", "a.js").startsWith("```js\n")).toBe(true);
  });

  it.each([
    ["a.py", "python"],
    ["a.pyi", "python"],
    ["a.mts", "ts"],
    ["a.cts", "ts"],
    ["a.mjs", "js"],
    ["a.cjs", "js"],
    ["a.rs", "rs"],
    ["a.TS", "ts"],
  ])("fences %s as %s", (path, language) => {
    expect(fencedCode("x", path)).toBe(`\`\`\`${language}\nx\n\`\`\``);
  });

  it("has an empty info string for a file with no extension", () => {
    expect(fencedCode("x", "Makefile")).toBe("```\nx\n```");
  });
});

describe("parseGoToLine", () => {
  it.each([
    ["12", 100, { line: 11, character: 0 }],
    ["12:5", 100, { line: 11, character: 4 }],
    ["12,5", 100, { line: 11, character: 4 }],
    ["  12  ", 100, { line: 11, character: 0 }],
    [" 12 : 5 ", 100, { line: 11, character: 4 }],
    ["12 , 5", 100, { line: 11, character: 4 }],
    ["1", 1, { line: 0, character: 0 }],
    ["100", 100, { line: 99, character: 0 }],
    ["3:0", 10, { line: 2, character: 0 }],
    ["3:999", 10, { line: 2, character: 998 }],
  ])("%j with %d lines", (input, lineCount, expected) => {
    expect(parseGoToLine(input, lineCount)).toEqual(expected);
  });

  it.each([
    ["0", 10],
    ["0:3", 10],
    ["11", 10],
    ["5", 0],
    ["", 10],
    ["   ", 10],
    ["abc", 10],
    ["12abc", 10],
    ["12:", 10],
    ["12:x", 10],
    ["-3", 10],
    ["1.5", 10],
    ["1:2:3", 10],
    [":5", 10],
  ])("is null for %j with %d lines", (input, lineCount) => {
    expect(parseGoToLine(input, lineCount)).toBeNull();
  });
});

describe("codeIntelOutcome", () => {
  it("passes a success through as the answer", () => {
    expect(codeIntelOutcome(AsyncResult.success({ locations: [] }))).toEqual({
      _tag: "answer",
      value: { locations: [] },
    });
  });

  it("reports an interrupt-only cause as interrupted", () => {
    expect(codeIntelOutcome(AsyncResult.failure(Cause.interrupt()))).toEqual({
      _tag: "interrupted",
    });
  });

  it("reports an older server as unsupported", () => {
    expect(
      codeIntelOutcome(AsyncResult.failure(Cause.fail(new CodeIntelUnsupportedError()))),
    ).toEqual({ _tag: "unsupported" });
  });

  it.each([
    "unsupported_language",
    "server_unavailable",
    "server_failed",
    "timeout",
    "stale_document",
    "file_too_large",
    "not_found",
    "path_not_allowed",
  ] as const)("carries the %s reason and message of a CodeIntelError", (reason) => {
    expect(
      codeIntelOutcome(
        AsyncResult.failure(
          Cause.fail(new CodeIntelError({ reason, message: `because ${reason}` })),
        ),
      ),
    ).toEqual({ _tag: "failed", reason, message: `because ${reason}` });
  });

  it("reports a defect's message", () => {
    expect(
      codeIntelOutcome(AsyncResult.failure(Cause.die(new Error("language server crashed")))),
    ).toEqual({ _tag: "defect", message: "language server crashed" });
  });

  it("falls back to a fixed message for a defect with no usable message", () => {
    const fallback = { _tag: "defect", message: "The language server request failed" };
    expect(codeIntelOutcome(AsyncResult.failure(Cause.die(new Error("  "))))).toEqual(fallback);
    expect(codeIntelOutcome(AsyncResult.failure(Cause.die("a string")))).toEqual(fallback);
  });

  it("treats an unrecognised typed error as a defect, not as failed or unsupported", () => {
    const outcome = codeIntelOutcome(AsyncResult.failure(Cause.fail(new Error("boom"))));
    expect(outcome._tag).toBe("defect");
  });

  it("does not report an interrupt mixed with a real failure as interrupted", () => {
    const mixed = Cause.combine(
      Cause.interrupt(),
      Cause.fail(new CodeIntelError({ reason: "timeout", message: "slow" })),
    );
    expect(codeIntelOutcome(AsyncResult.failure(mixed))).toEqual({
      _tag: "failed",
      reason: "timeout",
      message: "slow",
    });
  });
});

describe("codeIntelStep", () => {
  type Answer = { readonly revision: string };
  const answer: CodeIntelOutcome<Answer> = { _tag: "answer", value: { revision: "r1" } };
  const stale: CodeIntelOutcome<Answer> = {
    _tag: "failed",
    reason: "stale_document",
    message: "changed",
  };
  const clean = { revision: "r1", unsaved: false };
  const unsaved = { revision: "r1", unsaved: true };
  const saveToNavigate = { _tag: "hint", message: "Save to navigate" };

  it("uses an answer for the revision the viewer shows", () => {
    expect(codeIntelStep(answer, clean, false)).toEqual({ _tag: "use", value: answer.value });
  });

  it("drops an answer for a revision the viewer no longer shows, retried or not", () => {
    const edited = { revision: "r2", unsaved: true };
    expect(codeIntelStep(answer, edited, false)).toEqual({ _tag: "close" });
    expect(codeIntelStep(answer, { ...edited, unsaved: false }, true)).toEqual({ _tag: "close" });
  });

  it("asks for a save while the server has not seen the buffer's edits, never reloading it", () => {
    expect(codeIntelStep(stale, unsaved, false)).toEqual(saveToNavigate);
    expect(codeIntelStep(stale, unsaved, true)).toEqual(saveToNavigate);
  });

  it("reloads a clean file that changed on disk once, then reports the failure", () => {
    expect(codeIntelStep(stale, clean, false)).toEqual({ _tag: "reload" });
    expect(codeIntelStep(stale, clean, true)).toEqual(stale);
  });

  it("passes other failures through, whatever the buffer", () => {
    const timeout: CodeIntelOutcome<Answer> = {
      _tag: "failed",
      reason: "timeout",
      message: "slow",
    };
    expect(codeIntelStep(timeout, unsaved, false)).toEqual(timeout);
    expect(codeIntelStep(timeout, clean, false)).toEqual(timeout);
  });
});
