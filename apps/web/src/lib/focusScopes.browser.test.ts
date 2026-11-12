import { describe, expect, it } from "vite-plus/test";

import { type FocusScope, focusScopeProps, NO_FOCUS_SCOPES, readFocusScopes } from "./focusScopes";

function mount(tag: string, parent: ParentNode = document.body, ...scopes: FocusScope[]) {
  const element = document.createElement(tag);
  if (scopes.length > 0) {
    for (const [name, value] of Object.entries(focusScopeProps(...scopes))) {
      element.setAttribute(name, value);
    }
  }
  if (tag === "div") element.tabIndex = -1;
  parent.append(element);
  return element;
}

function mountPane(...scopes: FocusScope[]) {
  const pane = mount("div", document.body, ...scopes);
  return Object.assign(pane, { [Symbol.dispose]: () => pane.remove() });
}

describe("readFocusScopes", () => {
  it("finds the scopes of a pane from focus inside its nested shadow roots", () => {
    using pane = mountPane("code", "diff");
    // Pierre renders a diff as a host inside a host, with the focusable code in the inner root.
    const outerRoot = mount("x-diff-view", pane).attachShadow({ mode: "open" });
    const innerHost = mount("x-diff-file", outerRoot);
    const code = mount("div", innerHost.attachShadow({ mode: "open" }));
    code.focus();

    const both = { codeFocus: true, diffFocus: true, projectTreeFocus: false };
    // A key pressed in there reaches window listeners targeting the outer host.
    expect(document.activeElement).toBe(outerRoot.host);
    expect(readFocusScopes()).toEqual(both);
    expect(readFocusScopes(innerHost)).toEqual(both);
  });

  it("adds up the scopes of nested elements and holds none outside them", () => {
    using pane = mountPane("code");
    const diff = mount("div", pane, "diff");
    using outside = mountPane();

    diff.focus();
    expect(readFocusScopes()).toEqual({
      codeFocus: true,
      diffFocus: true,
      projectTreeFocus: false,
    });
    pane.focus();
    expect(readFocusScopes()).toEqual({ ...NO_FOCUS_SCOPES, codeFocus: true });
    outside.focus();
    expect(readFocusScopes()).toEqual(NO_FOCUS_SCOPES);
    expect(readFocusScopes(null)).toEqual(NO_FOCUS_SCOPES);
  });

  it("leaves a text field in a code pane its own keys, but not the tree's search field", () => {
    using pane = mountPane("code", "diff");
    // A diff comment box is slotted: light DOM under the host, drawn inside its shadow root.
    const host = mount("x-diff-view", pane);
    host.attachShadow({ mode: "open" }).append(document.createElement("slot"));
    const comment = mount("textarea", host);
    const find = mount("input", pane);
    const toggle = mount("input", pane);
    toggle.setAttribute("type", "checkbox");
    using tree = mountPane("project-tree");
    const search = mount("input", tree);

    for (const field of [comment, find]) {
      field.focus();
      expect(readFocusScopes()).toEqual(NO_FOCUS_SCOPES);
    }
    // A checkbox in the pane's toolbar takes no typing, so the pane's keys still work from it.
    toggle.focus();
    expect(readFocusScopes()).toEqual({
      codeFocus: true,
      diffFocus: true,
      projectTreeFocus: false,
    });
    search.focus();
    expect(readFocusScopes()).toEqual({ ...NO_FOCUS_SCOPES, projectTreeFocus: true });
  });

  it("holds no scope while a frame inside a pane has the focus", () => {
    using pane = mountPane("code");
    const frame = mount("iframe", pane);
    frame.focus();

    expect(document.activeElement).toBe(frame);
    expect(readFocusScopes()).toEqual(NO_FOCUS_SCOPES);
  });
});
