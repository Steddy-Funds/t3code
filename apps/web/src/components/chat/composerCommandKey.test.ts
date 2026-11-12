import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import { composerCommandKeyHandler } from "./composerCommandKey";

type HandlerInput = Parameters<typeof composerCommandKeyHandler>[0];

function setup(dock: { docked: boolean; available: boolean }) {
  const submitComposer = vi.fn<HandlerInput["submitComposer"]>();
  const setComposerDocked = vi.fn<HandlerInput["setComposerDocked"]>();
  const input = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut: "enter",
    routeKind: "server",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    isLiteralPendingAnswer: false,
    composerDraftTarget: DraftId.make("draft-1"),
    promptRef: { current: "a long prompt" },
    composerMenuOpenRef: { current: false },
    composerEditorRef: { current: null },
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: "a long prompt" }),
    submitComposer,
    composerDocked: dock.docked,
    composerDockAvailable: dock.available,
    setComposerDocked,
  } as Partial<HandlerInput> as HandlerInput;
  const press = (modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey">>) =>
    composerCommandKeyHandler(input)("Enter", {
      key: "Enter",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...modifiers,
    } as KeyboardEvent);
  return { press, submitComposer, setComposerDocked };
}

describe("composerCommandKeyHandler docked composer", () => {
  it("docks on Cmd+Shift+Enter when there is room, without sending", () => {
    const { press, submitComposer, setComposerDocked } = setup({ docked: false, available: true });
    expect(press({ metaKey: true, shiftKey: true })).toBe(true);
    expect(setComposerDocked).toHaveBeenCalledWith(true);
    expect(submitComposer).not.toHaveBeenCalled();
  });

  it("leaves Cmd+Shift+Enter alone when docking is unavailable", () => {
    const { press, setComposerDocked } = setup({ docked: false, available: false });
    expect(press({ metaKey: true, shiftKey: true })).toBe(false);
    expect(setComposerDocked).not.toHaveBeenCalled();
  });

  it("adds lines on Enter and Cmd+Enter while docked, and sends on Cmd+Shift+Enter", () => {
    const { press, submitComposer } = setup({ docked: true, available: true });
    expect(press({})).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({ ctrlKey: true })).toBe(false);
    expect(submitComposer).not.toHaveBeenCalled();
    expect(press({ metaKey: true, shiftKey: true })).toBe(true);
    expect(submitComposer).toHaveBeenCalledOnce();
  });
});
