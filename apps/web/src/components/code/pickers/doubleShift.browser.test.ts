import { describe, expect, it, vi } from "vite-plus/test";

import { focusScopeProps } from "~/lib/focusScopes";

import { installDoubleShift } from "./doubleShift";

// The editor is a contenteditable in the viewer's shadow root; a review comment box or a popup's
// filter is a light DOM input slotted into the same viewer.
function mountCodeViewer() {
  const viewer = document.createElement("div");
  for (const [name, value] of Object.entries(focusScopeProps("code"))) {
    viewer.setAttribute(name, value);
  }
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  viewer.attachShadow({ mode: "open" }).append(editor, document.createElement("slot"));
  const commentBox = document.createElement("input");
  viewer.append(commentBox);
  document.body.append(viewer);
  return Object.assign(viewer, { editor, commentBox, [Symbol.dispose]: () => viewer.remove() });
}

function tapShiftTwice(from: HTMLElement) {
  from.focus();
  for (const type of ["keydown", "keyup", "keydown", "keyup"] as const) {
    from.dispatchEvent(new KeyboardEvent(type, { key: "Shift", bubbles: true, composed: true }));
  }
}

describe("installDoubleShift", () => {
  it("fires from the code editor but leaves a text field inside the viewer its Shift taps", () => {
    using viewer = mountCodeViewer();
    const onDoubleShift = vi.fn();
    using _listener = {
      [Symbol.dispose]: installDoubleShift({
        isOn: () => true,
        onDoubleShift,
      }),
    };

    tapShiftTwice(viewer.commentBox);
    expect(onDoubleShift).not.toHaveBeenCalled();

    tapShiftTwice(viewer.editor);
    expect(onDoubleShift).toHaveBeenCalledOnce();
  });
});
