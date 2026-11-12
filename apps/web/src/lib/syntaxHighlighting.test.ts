import { getFiletypeFromFileName } from "@pierre/diffs";
import { MATERIAL_OCEAN_THEME } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";
import { ALL_DIFF_THEME_NAMES, DIFF_THEME_NAMES } from "./diffRendering";

describe("dialect file types", () => {
  it.each([
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
  ])("%s highlights as %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language);
  });
});

it.each([
  "asm",
  "assembly",
  "s",
  ...["asm", "ASM", "s", "S", "nasm", "NASM"].map((ext) => `src/start.${ext}`),
])("highlights assembly in %s", async (hint) => {
  const language = hint.includes("/") ? getFiletypeFromFileName(hint) : hint;
  const highlighter = await getSyntaxHighlighterPromise(language);
  const code = "mov eax, 42 ; answer\nret";
  for (const theme of Object.values(DIFF_THEME_NAMES)) {
    const { tokens } = highlighter.codeToTokens(code, { lang: language, theme });
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  }
});

describe("theme syntax tables", () => {
  const syntax = MATERIAL_OCEAN_THEME.editor!.dark!.syntax.style.syntax;
  const theme = "material-deep-ocean";

  async function lineTokens(language: string, code: string, lineMarker: string) {
    const highlighter = await getSyntaxHighlighterPromise(language);
    const { tokens } = highlighter.codeToTokens(code, { lang: language, theme });
    const line = tokens.find((candidate) =>
      candidate
        .map((token) => token.content)
        .join("")
        .includes(lineMarker),
    );
    if (!line) throw new Error(`no line with ${lineMarker}`);
    return (content: string) => {
      const token = line.find((candidate) => candidate.content.trim() === content);
      if (!token) throw new Error(`no token ${content} on the line with ${lineMarker}`);
      return token;
    };
  }

  // The expected colour and italic flag come from the table, so a retuned theme keeps passing.
  function expectScope(token: { color?: string; fontStyle?: number }, key: string) {
    const setting = syntax[key]!;
    expect(token.color?.toLowerCase(), key).toBe(setting.color.toLowerCase());
    expect(((token.fontStyle ?? 0) & 1) === 1, `${key} italic`).toBe(
      setting.font_style === "italic",
    );
  }

  it("resolves every theme name synchronously on a highlighter", async () => {
    const highlighter = await getSyntaxHighlighterPromise("typescript");
    for (const name of ALL_DIFF_THEME_NAMES) {
      const { tokens } = highlighter.codeToTokens("const a = 'b'; // c", {
        lang: "typescript",
        theme: name,
      });
      expect(new Set(tokens.flat().map((token) => token.color)).size, name).toBeGreaterThan(1);
    }
  });

  it("colours Python from the theme's syntax table", async () => {
    const code = [
      "import os",
      "class Foo(Base):",
      "    def run(self, count: int = 3):",
      "        # note",
      "        if count:",
      '            return "hi"',
    ].join("\n");
    expectScope((await lineTokens("python", code, "class Foo"))("class"), "keyword.declaration");
    expectScope((await lineTokens("python", code, "class Foo"))("Foo"), "type.class");
    expectScope((await lineTokens("python", code, "def run"))("count"), "variable.parameter");
    expectScope((await lineTokens("python", code, "# note"))("# note"), "comment");
    expectScope((await lineTokens("python", code, "if count"))("if"), "keyword.control");
    expectScope((await lineTokens("python", code, "return"))('"hi"'), "string");
  });

  it("colours TypeScript from the theme's syntax table", async () => {
    const code = [
      "export class Foo extends Bar {",
      "  // note",
      "  run(count: number): string {",
      '    const x = "hi";',
      "    if (count) { return x; }",
      "  }",
      "}",
    ].join("\n");
    expectScope(
      (await lineTokens("typescript", code, "export class"))("class"),
      "keyword.declaration",
    );
    expectScope((await lineTokens("typescript", code, "export class"))("Foo"), "type.class");
    expectScope((await lineTokens("typescript", code, "run("))("count"), "variable.parameter");
    expectScope((await lineTokens("typescript", code, "// note"))("// note"), "comment");
    expectScope((await lineTokens("typescript", code, "const x"))("const"), "keyword.declaration");
    expectScope((await lineTokens("typescript", code, "const x"))('"hi"'), "string");
    expectScope((await lineTokens("typescript", code, "if ("))("if"), "keyword.control");
  });

  it("colours a JSON key apart from its string value", async () => {
    const line = await lineTokens("json", '{"key": "v"}', '"key"');
    expectScope(line('"key"'), "property.json_key");
    expectScope(line('"v"'), "string");
  });

  it("paints the same source differently under the stock dark theme", async () => {
    const highlighter = await getSyntaxHighlighterPromise("python");
    const colours = (name: string) =>
      highlighter
        .codeToTokens("class Foo:\n    pass", { lang: "python", theme: name })
        .tokens.flat()
        .map((token) => token.color);
    expect(colours(theme)).not.toEqual(colours(DIFF_THEME_NAMES.dark));
  });
});
