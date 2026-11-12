import type { ReactNode } from "react";

import { matchIndices } from "./codePickers.logic";

/** The name with the query's matched characters in bold; plain when the query does not match. */
export function HighlightedName(props: { readonly name: string; readonly query: string }) {
  const indices = matchIndices(props.name, props.query);
  if (indices === null || indices.length === 0) return props.name;
  const parts: ReactNode[] = [];
  let start = 0;
  for (const index of indices) {
    if (start < index) parts.push(props.name.slice(start, index));
    parts.push(
      <strong className="font-semibold" key={index}>
        {props.name[index]}
      </strong>,
    );
    start = index + 1;
  }
  if (start < props.name.length) parts.push(props.name.slice(start));
  return parts;
}
