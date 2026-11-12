import type { CodeSymbolKind } from "@t3tools/contracts";
import {
  BoxesIcon,
  BoxIcon,
  BracesIcon,
  CircleDotIcon,
  CircleIcon,
  ComponentIcon,
  FileCodeIcon,
  HashIcon,
  ListIcon,
  ListOrderedIcon,
  type LucideIcon,
  PackageIcon,
  SquareFunctionIcon,
  TypeIcon,
  VariableIcon,
} from "lucide-react";

import { ITEM_ICON_CLASS } from "../../CommandPalette.logic";

const KIND_ICONS: Record<CodeSymbolKind, LucideIcon> = {
  file: FileCodeIcon,
  module: PackageIcon,
  namespace: BracesIcon,
  class: BoxIcon,
  method: SquareFunctionIcon,
  property: CircleDotIcon,
  field: CircleDotIcon,
  constructor: SquareFunctionIcon,
  enum: ListOrderedIcon,
  interface: ComponentIcon,
  function: SquareFunctionIcon,
  variable: VariableIcon,
  constant: HashIcon,
  enumMember: ListIcon,
  struct: BoxesIcon,
  typeParameter: TypeIcon,
  other: CircleIcon,
};

const KIND_LABELS: Record<CodeSymbolKind, string> = {
  file: "File",
  module: "Module",
  namespace: "Namespace",
  class: "Class",
  method: "Method",
  property: "Property",
  field: "Field",
  constructor: "Constructor",
  enum: "Enum",
  interface: "Interface",
  function: "Function",
  variable: "Variable",
  constant: "Constant",
  enumMember: "Enum member",
  struct: "Struct",
  typeParameter: "Type parameter",
  other: "Symbol",
};

/** The kind shows on hover: the icon already tells them apart at a glance. */
export function SymbolKindIcon(props: { readonly kind: CodeSymbolKind }) {
  const Icon = KIND_ICONS[props.kind];
  const label = KIND_LABELS[props.kind];
  return (
    <Icon aria-label={label} className={ITEM_ICON_CLASS} data-symbol-kind={props.kind}>
      <title>{label}</title>
    </Icon>
  );
}
