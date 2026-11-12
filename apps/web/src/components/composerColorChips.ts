import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const HEX_COLOR = /#[0-9a-f]{6}\b/gi;

interface ChipState {
  readonly enabled: boolean;
  readonly decorations: DecorationSet;
}

const composerColorChipsKey = new PluginKey<ChipState>("composerColorChips");

function chip(hex: string) {
  const swatch = document.createElement("span");
  swatch.setAttribute("aria-hidden", "true");
  swatch.contentEditable = "false";
  swatch.style.cssText = `display:inline-block;width:0.8em;height:0.8em;margin-inline-end:0.2em;border-radius:0.2em;vertical-align:-0.05em;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 25%,transparent);background:${hex}`;
  return swatch;
}

function scan(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  const found: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "codeBlock") return false;
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === "code")) return false;
    for (const match of node.text?.matchAll(HEX_COLOR) ?? []) {
      const hex = match[0].toLowerCase();
      found.push(Decoration.widget(pos + match.index, () => chip(hex), { side: -1, key: hex }));
    }
    return false;
  });
  return found;
}

/** Top-level block bounds around a position, so an edit rescans only the blocks it touched. */
function blockBounds(doc: ProseMirrorNode, from: number, to: number) {
  const start = doc.resolve(Math.min(from, doc.content.size));
  const end = doc.resolve(Math.min(to, doc.content.size));
  return {
    from: start.depth > 0 ? start.before(1) : 0,
    to: end.depth > 0 ? end.after(1) : doc.content.size,
  };
}

/** A color swatch before each `#RRGGBB` in the draft, while `isEnabled` says so. */
export function composerColorChips(options: { readonly isEnabled: () => boolean }): Extension {
  const full = (doc: ProseMirrorNode): ChipState => {
    const enabled = options.isEnabled();
    return {
      enabled,
      decorations: enabled
        ? DecorationSet.create(doc, scan(doc, 0, doc.content.size))
        : DecorationSet.empty,
    };
  };
  return Extension.create({
    name: "composerColorChips",
    addProseMirrorPlugins() {
      return [
        new Plugin<ChipState>({
          key: composerColorChipsKey,
          state: {
            init: (_config, state) => full(state.doc),
            apply(transaction, value) {
              if (!transaction.docChanged) return value;
              if (options.isEnabled() !== value.enabled) return full(transaction.doc);
              if (!value.enabled) return value;
              const doc = transaction.doc;
              let decorations = value.decorations.map(transaction.mapping, doc);
              transaction.mapping.maps.forEach((map, index) => {
                const rest = transaction.mapping.slice(index + 1);
                map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                  const bounds = blockBounds(doc, rest.map(newStart, -1), rest.map(newEnd, 1));
                  decorations = decorations
                    .remove(decorations.find(bounds.from, bounds.to))
                    .add(doc, scan(doc, bounds.from, bounds.to));
                });
              });
              return { enabled: true, decorations };
            },
          },
          props: {
            decorations: (state) => composerColorChipsKey.getState(state)?.decorations,
          },
        }),
      ];
    },
  });
}
