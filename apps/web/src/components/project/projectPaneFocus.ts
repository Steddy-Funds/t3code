// Where keyboard focus was before a shortcut moved it into the tree. Module state: the pane
// re-renders and may remount between the two presses.
let returnTarget: HTMLElement | null = null;

function deepActiveElement(): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

export function rememberFocusBeforeTree(): void {
  const active = deepActiveElement();
  returnTarget = active instanceof HTMLElement && active !== document.body ? active : null;
}

/** Back to the code the shortcut came from, or else the file open now. */
export function restoreFocusAfterTree(): void {
  const candidates = [
    returnTarget,
    ...document.querySelectorAll<HTMLElement>('[data-focus-scope~="code"]'),
  ];
  returnTarget = null;
  const target = candidates.find(
    (element) => element?.isConnected && element.getClientRects().length > 0,
  );
  target?.focus({ preventScroll: true });
}
