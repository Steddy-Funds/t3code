export type FocusScope = "code" | "diff" | "project-tree";

/** The `when` variables the focus scopes provide. */
export type FocusScopes = {
  readonly codeFocus: boolean;
  readonly diffFocus: boolean;
  readonly projectTreeFocus: boolean;
};

export const NO_FOCUS_SCOPES: FocusScopes = {
  codeFocus: false,
  diffFocus: false,
  projectTreeFocus: false,
};

const SCOPE_ATTRIBUTE = "data-focus-scope";

/**
 * Marks an element as one or more scopes. A scope holds only while keyboard focus is inside the
 * element, so a read-only surface needs something there that a click can focus.
 */
export function focusScopeProps(...scopes: ReadonlyArray<FocusScope>) {
  return { [SCOPE_ATTRIBUTE]: scopes.join(" ") };
}

function parentAcrossShadowRoots(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/**
 * The scopes holding keyboard focus, read from the focused element out through open shadow
 * roots, whose key events target the host. Scopes of nested elements add up.
 */
export function readFocusScopes(target: EventTarget | null = document.activeElement): FocusScopes {
  let focused = target instanceof Element ? target : null;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  // A frame holds another document's focus, which is never the code around the frame.
  if (focused === null || focused.matches("iframe, webview")) return NO_FOCUS_SCOPES;

  const scopes = new Set<string>();
  for (let element: Element | null = focused; element; element = parentAcrossShadowRoots(element)) {
    for (const scope of element.getAttribute(SCOPE_ATTRIBUTE)?.split(/\s+/) ?? []) {
      scopes.add(scope);
    }
  }
  // A comment box or find field inside a code pane types text, so it keeps its own keys. The
  // Project tree's search field belongs to the tree and stays in its scope.
  const inTextField = focused.matches("input, textarea");
  return {
    codeFocus: !inTextField && scopes.has("code"),
    diffFocus: !inTextField && scopes.has("diff"),
    projectTreeFocus: scopes.has("project-tree"),
  };
}
