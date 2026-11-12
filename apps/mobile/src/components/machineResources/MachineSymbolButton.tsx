import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable } from "react-native";

import { machineIndicator } from "../../state/machineResources";
import { EnvironmentMachineSymbol } from "../EnvironmentMachineSymbol";
import { MachineResourcesSheet } from "./MachineResourcesSheet";

/** The machine's indicator; a tap opens its resources sheet when the machine serves the verdict. */
export function MachineSymbolButton(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}) {
  const { show } = useAtomValue(machineIndicator.machineIndicatorAtom(props.environmentId));
  const [open, setOpen] = useState(false);
  const symbol = (
    <EnvironmentMachineSymbol
      environmentId={props.environmentId}
      kind={props.kind}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
    />
  );
  return (
    <>
      {show ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${props.label} machine resources`}
          hitSlop={10}
          className="active:opacity-60"
          onPress={() => setOpen(true)}
        >
          {symbol}
        </Pressable>
      ) : (
        symbol
      )}
      {open ? (
        <MachineResourcesSheet
          environmentId={props.environmentId}
          title={props.label}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
