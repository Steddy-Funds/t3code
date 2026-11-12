import type { CodeSemanticTokensLegend } from "@t3tools/contracts";
import {
  getThemeEditorColors,
  MATERIAL_OCEAN_THEME,
  type ThemeEditorColors,
} from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import {
  adoptSemanticHighlightStyles,
  SEMANTIC_HIGHLIGHT_PRIORITY,
  type SemanticHighlightOf,
  SemanticHighlighter,
  type SemanticRowSource,
  type SemanticToken,
  semanticHighlightResolver,
} from "./semanticHighlighting";

// Rows as Pierre renders them: one element per line, its text split over token spans.
function viewer(rows: ReadonlyArray<ReadonlyArray<string>>): ShadowRoot & Disposable {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  rows.forEach((pieces, index) => {
    const row = document.createElement("div");
    row.dataset.line = String(index + 1);
    for (const piece of pieces) {
      const span = document.createElement("span");
      span.textContent = piece;
      row.append(span);
    }
    root.append(row);
  });
  return Object.assign(root, { [Symbol.dispose]: () => host.remove() });
}

const token = (start: number, length: number, type = 0): SemanticToken => ({
  start,
  length,
  type,
  modifiers: 0,
});

function painted(highlight: Highlight): string[] {
  return [...highlight].map((range) => (range as Range).toString());
}

function paintAll(
  root: ParentNode,
  sources: Record<number, SemanticRowSource>,
  highlight = new Highlight(),
) {
  const highlighter = new SemanticHighlighter();
  const highlightOf: SemanticHighlightOf = () => highlight;
  highlighter.paint(root, (line) => sources[line] ?? null, highlightOf);
  return { highlighter, highlight };
}

describe("SemanticHighlighter", () => {
  it("covers each token's UTF-16 columns across spans, tabs and astral characters", () => {
    using root = viewer([["\tdef gr", "eet(", "name", "):"], ["😀 = ", "name"], ["\n"]]);

    const { highlight } = paintAll(root, {
      0: { text: "\tdef greet(name):", tokens: [token(5, 5), token(11, 4)] },
      1: { text: "😀 = name", tokens: [token(0, 2), token(5, 4)] },
      2: { text: "", tokens: [token(0, 3)] },
    });

    expect(painted(highlight)).toEqual(["greet", "name", "😀", "name"]);
  });

  it("leaves a row alone when its text is not the text the tokens were for", () => {
    using root = viewer([["self.total"], ["count = len(lines)"]]);

    const { highlight } = paintAll(root, {
      0: { text: "self.totals", tokens: [token(0, 4)] },
      1: { text: "count = len(lines)", tokens: [token(0, 5)] },
    });

    expect(painted(highlight)).toEqual(["count"]);
  });

  it("clips a token that claims to run past its line", () => {
    using root = viewer([["value = '''doc"]]);

    const { highlight } = paintAll(root, {
      0: { text: "value = '''doc", tokens: [token(8, 40)] },
    });

    expect(painted(highlight)).toEqual(["'''doc"]);
  });

  it("takes back only its own ranges from a highlight two viewers share", () => {
    using first = viewer([["alpha"]]);
    using second = viewer([["beta"]]);
    const shared = new Highlight();
    const a = paintAll(first, { 0: { text: "alpha", tokens: [token(0, 5)] } }, shared);
    paintAll(second, { 0: { text: "beta", tokens: [token(0, 4)] } }, shared);

    a.highlighter.clear();

    expect(painted(shared)).toEqual(["beta"]);
  });

  it("drops its earlier ranges when it paints again", () => {
    using root = viewer([["alpha"]]);
    const { highlighter, highlight } = paintAll(root, {
      0: { text: "alpha", tokens: [token(0, 5)] },
    });

    highlighter.paint(
      root,
      () => ({ text: "alpha", tokens: [token(0, 2)] }),
      () => highlight,
    );

    expect(painted(highlight)).toEqual(["al"]);
  });
});

describe("semanticHighlightResolver", () => {
  const ocean = getThemeEditorColors(MATERIAL_OCEAN_THEME, "dark")!;
  const theme: ThemeEditorColors = {
    ...ocean,
    semantic: {
      function: { color: "#111111" },
      "function.declaration": { color: "#222222" },
      "*.builtin": { color: "#333333" },
      parameter: { color: "not a colour" },
    },
  };
  // ty says `definition`; TypeScript says `declaration` and `defaultLibrary`.
  const legend: CodeSemanticTokensLegend = {
    tokenTypes: ["function", "parameter", "keyword"],
    tokenModifiers: ["definition", "readonly", "defaultLibrary"],
  };

  function colorOf(highlight: Highlight | null): string | null {
    if (highlight === null) return null;
    const name = [...CSS.highlights].find(([, value]) => value === highlight)?.[0];
    using root = viewer([]);
    adoptSemanticHighlightStyles(root);
    const rules = [...root.adoptedStyleSheets.at(-1)!.cssRules] as CSSStyleRule[];
    return rules.find((rule) => rule.selectorText === `::highlight(${name})`)?.style.color ?? null;
  }

  it("reads the server's modifiers as the theme names them", () => {
    const highlightOf = semanticHighlightResolver(theme, legend);
    const of = (type: number, modifiers: number) =>
      colorOf(highlightOf({ start: 0, length: 1, type, modifiers }));

    expect(of(0, 0)).toBe("rgb(17, 17, 17)");
    expect(of(0, 0b001)).toBe("rgb(34, 34, 34)");
    expect(of(0, 0b100)).toBe("rgb(51, 51, 51)");
    // A modifier the theme has no style for falls back to the type's own.
    expect(of(0, 0b010)).toBe("rgb(17, 17, 17)");
  });

  it("paints nothing for a type the theme or legend lacks, or a colour CSS rejects", () => {
    const highlightOf = semanticHighlightResolver(theme, legend);

    expect(highlightOf(token(0, 1, 2))).toBeNull();
    expect(highlightOf(token(0, 1, 9))).toBeNull();
    expect(highlightOf(token(0, 1, 1))).toBeNull();
  });

  it("shares one highlight per colour, drawn under D1's highlights and the in-file find", () => {
    const first = semanticHighlightResolver(theme, legend)(token(0, 1, 0));
    const second = semanticHighlightResolver(
      { ...theme, semantic: { method: { color: "#111111" } } },
      { tokenTypes: ["method"], tokenModifiers: [] },
    )(token(0, 1, 0));

    expect(second).toBe(first);
    expect(first?.priority).toBe(SEMANTIC_HIGHLIGHT_PRIORITY);
    expect(SEMANTIC_HIGHLIGHT_PRIORITY).toBeLessThan(0);
  });

  it("adopts its rules into a viewer's shadow root once", () => {
    using root = viewer([]);
    adoptSemanticHighlightStyles(root);
    adoptSemanticHighlightStyles(root);

    expect(root.adoptedStyleSheets).toHaveLength(1);
  });
});
