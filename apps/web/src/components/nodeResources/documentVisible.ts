import { Atom } from "effect/reactivity";

import { getDocumentActivity, subscribeDocumentActivity } from "~/lib/documentActivity";

/** Whether the tab is visible; machine streams close while it isn't and reseed from history on return. */
export const documentVisibleAtom = Atom.make((get) => {
  get.addFinalizer(subscribeDocumentActivity(() => get.setSelf(getDocumentActivity().visible)));
  return getDocumentActivity().visible;
}).pipe(Atom.withLabel("machine-document-visible"));
