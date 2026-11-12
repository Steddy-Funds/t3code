import { describe, expect, it } from "@effect/vitest";

import {
  BUILT_IN_THEMES,
  MATERIAL_OCEAN_THEME,
  THEME_SYNTAX_THEME_NAMES,
  getThemeEditorColors,
  semanticTokenStyle,
  type ThemeEditorColors,
} from "./themePalettes.ts";

const HEX = /^#[0-9a-f]{6}$/i;

const materialOceanEditor = getThemeEditorColors(MATERIAL_OCEAN_THEME, "dark");

function withSemantic(semantic: ThemeEditorColors["semantic"]): ThemeEditorColors {
  if (!materialOceanEditor) throw new Error("material-ocean has no dark editor block");
  return { ...materialOceanEditor, semantic };
}

describe("getThemeEditorColors", () => {
  it("gives material-ocean's block for dark only", () => {
    expect(materialOceanEditor).toBe(MATERIAL_OCEAN_THEME.editor?.dark);
    expect(getThemeEditorColors(MATERIAL_OCEAN_THEME, "light")).toBeNull();
  });

  it("gives nothing for every other built-in theme, in both appearances", () => {
    const others = BUILT_IN_THEMES.filter((theme) => theme.id !== MATERIAL_OCEAN_THEME.id);
    expect(others.length).toBeGreaterThan(0);
    for (const theme of others) {
      expect(theme.editor, theme.id).toBeUndefined();
      expect(getThemeEditorColors(theme, "light"), `${theme.id} light`).toBeNull();
      expect(getThemeEditorColors(theme, "dark"), `${theme.id} dark`).toBeNull();
    }
  });

  it("gives nothing for no theme", () => {
    expect(getThemeEditorColors(null, "dark")).toBeNull();
    expect(getThemeEditorColors(null, "light")).toBeNull();
  });

  it("gives nothing for a theme with colours but no editor block", () => {
    const { editor: _editor, ...custom } = MATERIAL_OCEAN_THEME;
    expect(getThemeEditorColors({ ...custom, id: "custom" }, "dark")).toBeNull();
  });
});

describe("material-ocean editor block", () => {
  it("is the only editor block among the built-ins, and dark only", () => {
    const withEditor = BUILT_IN_THEMES.filter((theme) => theme.editor !== undefined);
    expect(withEditor.map((theme) => theme.id)).toEqual(["material-ocean"]);
    expect(Object.keys(MATERIAL_OCEAN_THEME.editor ?? {})).toEqual(["dark"]);
    expect(MATERIAL_OCEAN_THEME.appearance).toBe("dark");
    expect(MATERIAL_OCEAN_THEME.variants).toBeUndefined();
  });

  it("paints chrome as Material Oceanic and code as Material Deep Ocean", () => {
    const { colors } = MATERIAL_OCEAN_THEME;
    expect(colors.canvas).toBe("#263238");
    expect(colors.text).toBe("#b0bec5");
    expect(colors.accent).toBe("#009688");
    expect(colors.codeBackground).toBe("#0f111a");
    expect(colors.codeForeground).toBe("#c3cee3");
    expect(colors.terminalBackground).toBe("#0f111a");
    expect(colors.terminalForeground).toBe("#c3cee3");
  });

  it("names a registered syntax theme that matches its appearance", () => {
    const editor = materialOceanEditor!;
    expect(THEME_SYNTAX_THEME_NAMES).toContain(editor.syntax.name);
    expect(editor.syntax.name).toBe("material-deep-ocean");
    expect(editor.syntax.appearance).toBe("dark");
  });

  it("lists exactly the syntax themes the built-ins carry", () => {
    const names = BUILT_IN_THEMES.flatMap((theme) =>
      Object.values(theme.editor ?? {}).map((editor) => editor.syntax.name),
    );
    expect([...names].toSorted()).toEqual([...THEME_SYNTAX_THEME_NAMES].toSorted());
  });

  it("has 16 ANSI colours, each a six-digit hex", () => {
    const { ansi } = materialOceanEditor!;
    expect(ansi).toHaveLength(16);
    for (const colour of ansi) expect(colour).toMatch(HEX);
  });

  it("has hex line number, caret row, diff and find colours", () => {
    const { lineNumber, caretRow, diff, find } = materialOceanEditor!;
    expect(lineNumber).toMatch(HEX);
    expect(caretRow).toMatch(HEX);
    for (const kind of [diff.inserted, diff.deleted, diff.modified, diff.conflict]) {
      expect(kind.line).toMatch(HEX);
      expect(kind.muted).toMatch(HEX);
      expect(kind.word).toMatch(HEX);
    }
    expect(find.match).toMatch(HEX);
    expect(find.currentMatch).toMatch(HEX);
    expect(find.foreground).toMatch(HEX);
  });

  it("gives every syntax setting and semantic style a hex colour", () => {
    const { syntax, semantic } = materialOceanEditor!;
    for (const [key, setting] of Object.entries(syntax.style.syntax)) {
      expect(setting.color, key).toMatch(HEX);
    }
    for (const [key, style] of Object.entries(semantic)) {
      expect(style.color, key).toMatch(HEX);
    }
  });
});

describe("semanticTokenStyle", () => {
  const red = { color: "#ff0000" } as const;
  const green = { color: "#00ff00" } as const;
  const blue = { color: "#0000ff" } as const;
  const yellow = { color: "#ffff00" } as const;

  it("gives null for no theme", () => {
    expect(semanticTokenStyle(null, "function")).toBeNull();
    expect(semanticTokenStyle(null, "function", ["static"])).toBeNull();
  });

  it("gives null for a type the theme does not style", () => {
    const theme = withSemantic({ function: red });
    expect(semanticTokenStyle(theme, "macro")).toBeNull();
    expect(semanticTokenStyle(theme, "macro", ["static"])).toBeNull();
  });

  it("gives the bare type with no modifiers", () => {
    const theme = withSemantic({ function: red, "function.static": green, "*.static": blue });
    expect(semanticTokenStyle(theme, "function")).toBe(red);
    expect(semanticTokenStyle(theme, "function", [])).toBe(red);
  });

  it("falls back to the bare type when no modifier entry matches", () => {
    const theme = withSemantic({ function: red, "function.static": green });
    expect(semanticTokenStyle(theme, "function", ["async"])).toBe(red);
  });

  it("lets a type.modifier entry win over a *.modifier entry", () => {
    const theme = withSemantic({ function: red, "function.builtin": green, "*.builtin": blue });
    expect(semanticTokenStyle(theme, "function", ["builtin"])).toBe(green);
  });

  it("lets a *.modifier entry win over the bare type", () => {
    const theme = withSemantic({ function: red, "*.builtin": blue });
    expect(semanticTokenStyle(theme, "function", ["builtin"])).toBe(blue);
  });

  it("applies a *.modifier entry to a type the theme does not style", () => {
    const theme = withSemantic({ "*.builtin": blue });
    expect(semanticTokenStyle(theme, "keyword", ["builtin"])).toBe(blue);
  });

  it("lets a later modifier's type entry win over an earlier modifier's wildcard entry", () => {
    const theme = withSemantic({
      function: red,
      "*.static": blue,
      "function.async": green,
    });
    expect(semanticTokenStyle(theme, "function", ["static", "async"])).toBe(green);
  });

  it("breaks ties between modifiers by their order", () => {
    const theme = withSemantic({ "function.static": green, "function.async": yellow });
    expect(semanticTokenStyle(theme, "function", ["static", "async"])).toBe(green);
    expect(semanticTokenStyle(theme, "function", ["async", "static"])).toBe(yellow);

    const wildcards = withSemantic({ "*.static": green, "*.async": yellow });
    expect(semanticTokenStyle(wildcards, "function", ["static", "async"])).toBe(green);
    expect(semanticTokenStyle(wildcards, "function", ["async", "static"])).toBe(yellow);
  });

  it("skips modifiers it has no entry for", () => {
    const theme = withSemantic({ "function.async": yellow, function: red });
    expect(semanticTokenStyle(theme, "function", ["readonly", "async"])).toBe(yellow);
  });

  it("does not read a modifier entry of another type", () => {
    const theme = withSemantic({ "method.static": green });
    expect(semanticTokenStyle(theme, "function", ["static"])).toBeNull();
  });

  it("resolves material-ocean's own entries", () => {
    expect(semanticTokenStyle(materialOceanEditor, "function")).toEqual({ color: "#82aaff" });
    // `method.static` beats the bare `method`.
    expect(semanticTokenStyle(materialOceanEditor, "method", ["static"])).toEqual({
      color: "#82aaff",
      italic: true,
    });
    expect(semanticTokenStyle(materialOceanEditor, "method")).toEqual({ color: "#82aaff" });
    // `*.builtin` beats the bare `variable`, and styles a type the table does not list.
    expect(semanticTokenStyle(materialOceanEditor, "variable", ["builtin"])).toEqual({
      color: "#82aaff",
      italic: true,
    });
    expect(semanticTokenStyle(materialOceanEditor, "keyword", ["builtin"])).toEqual({
      color: "#82aaff",
      italic: true,
    });
    expect(semanticTokenStyle(materialOceanEditor, "variable", ["readonly"])).toEqual({
      color: "#eeffe3",
    });
    expect(semanticTokenStyle(materialOceanEditor, "notAType")).toBeNull();
  });
});
