import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useEffect } from "react";
import { Animated, Easing, useAnimatedValue, View } from "react-native";

import { useAppActive, useReduceMotionEnabled } from "../lib/appState";
import { machineIndicator } from "../state/machineResources";
import { useMachineStressColor } from "./machineResources/stressColor";
import { SymbolView, type AppSymbolName } from "./ui/AppSymbol";

export const ENVIRONMENT_MACHINE_SYMBOLS = {
  server: "server.rack",
  cloud: "cloud",
  linux: "terminal",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  "mac-mini": "macmini",
  "mac-studio": "macstudio",
} as const satisfies Record<EnvironmentMachineKind, AppSymbolName>;

const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export type MachineSymbolState = "ok" | "unknown" | "stressed" | "unreachable-stressed";

export function machineSymbolState(indicator: MachineIndicator): MachineSymbolState {
  if (!indicator.show) return "ok";
  if (indicator.unreachable) {
    return indicator.lastSeen?.verdict === "stressed" ? "unreachable-stressed" : "unknown";
  }
  return indicator.verdict;
}

interface MachineSymbolProps {
  readonly kind: EnvironmentMachineKind;
  readonly size: number;
  readonly tintColorClassName: string;
}

/** With `environmentId`, the symbol is that machine's stress indicator; without, the plain kind glyph. */
export function EnvironmentMachineSymbol(
  props: MachineSymbolProps & { readonly environmentId?: EnvironmentId | undefined },
) {
  if (props.environmentId === undefined) return <MachineGlyph {...props} />;
  return <IndicatedMachineSymbol {...props} environmentId={props.environmentId} />;
}

function MachineGlyph(props: MachineSymbolProps) {
  return (
    <SymbolView
      accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[props.kind]}
      name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
      size={props.size}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
    />
  );
}

const DIMMED_OPACITY = 0.42;
const HALO_SCALE = 1.76;

function IndicatedMachineSymbol(
  props: MachineSymbolProps & { readonly environmentId: EnvironmentId },
) {
  const state = machineSymbolState(
    useAtomValue(machineIndicator.machineIndicatorAtom(props.environmentId)),
  );
  const stressColor = useMachineStressColor();
  if (state === "ok") return <MachineGlyph {...props} />;
  const stressed = state === "stressed";
  const haloSize = props.size * HALO_SCALE;
  return (
    <View style={{ width: props.size, height: props.size, opacity: stressed ? 1 : DIMMED_OPACITY }}>
      {stressed ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: (props.size - haloSize) / 2,
            top: (props.size - haloSize) / 2,
            width: haloSize,
            height: haloSize,
            borderRadius: haloSize / 2,
            backgroundColor: stressColor,
            opacity: 0.18,
          }}
        />
      ) : null}
      {stressed ? (
        <SymbolView
          accessibilityLabel={ENVIRONMENT_MACHINE_KIND_LABELS[props.kind]}
          name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
          size={props.size}
          tintColor={stressColor}
          type="monochrome"
        />
      ) : (
        <MachineGlyph {...props} />
      )}
      {state === "unknown" ? null : (
        <MachineDrops
          size={props.size}
          animate={stressed}
          tint={stressed ? { color: stressColor } : { className: props.tintColorClassName }}
        />
      )}
    </View>
  );
}

const DRIP_MS = 2000;
// One loop of a drop: it forms, runs down beside the glyph, and fades.
const DRIP_INPUT = [0, 0.22, 0.72, 0.88, 1];
const FORMED_PHASE = 0.22;
// Sized and placed relative to the glyph, up and to its right, outside its box so nothing shifts.
const DROPS = [
  { scale: 0.34, top: -0.3, right: -0.3, phaseOffset: 0 },
  { scale: 0.24, top: 0.04, right: -0.44, phaseOffset: 0.5 },
] as const;

type DropPhase = ReturnType<typeof Animated.modulo>;

function dropStyle(phase: DropPhase, dropSize: number, small: boolean) {
  const [run, end] = small ? [1.3, 1.6] : [1.9, 2.4];
  return {
    opacity: phase.interpolate({
      inputRange: DRIP_INPUT,
      outputRange: small ? [0, 0.8, 0.6, 0, 0] : [0, 1, 0.9, 0, 0],
    }),
    transform: [
      {
        translateY: phase.interpolate({
          inputRange: DRIP_INPUT,
          outputRange: [-0.2 * dropSize, 0, run * dropSize, end * dropSize, end * dropSize],
        }),
      },
      {
        scale: phase.interpolate({ inputRange: DRIP_INPUT, outputRange: [0.3, 1, 0.85, 0.7, 0.7] }),
      },
    ],
  };
}

/**
 * The sweat drops, in the symbol's own View. Only a stressed symbol drips, and only while the app
 * is active, the screen focused and reduced motion off; otherwise the drops sit formed.
 */
function MachineDrops(props: {
  readonly size: number;
  readonly animate: boolean;
  readonly tint: { readonly color: string } | { readonly className: string };
}) {
  const appIsActive = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const screenIsFocused = useIsFocused();
  const progress = useAnimatedValue(FORMED_PHASE);
  const running = props.animate && appIsActive && screenIsFocused && !reducedMotion;

  // Runs on React Native's native driver instead of Reanimated, whose per-frame commits starve
  // React's while commit pausing is disabled (package.json), as thread-work-log's shimmer does.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the native-driver drip loop while stressed and visible, and stops it on cleanup
  useEffect(() => {
    if (!running) {
      progress.setValue(FORMED_PHASE);
      return;
    }
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: DRIP_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, running]);

  const small = props.size <= 12;
  return DROPS.map((drop) => {
    const dropSize = Math.max(4, Math.round(props.size * drop.scale));
    // At rest both drops sit at the formed phase; running, the second trails by half a loop.
    const phase = Animated.modulo(Animated.add(progress, running ? drop.phaseOffset : 0), 1);
    return (
      <Animated.View
        key={drop.phaseOffset}
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: "absolute",
            top: props.size * drop.top,
            right: props.size * drop.right,
            width: dropSize,
            height: dropSize,
          },
          dropStyle(phase, dropSize, small),
        ]}
      >
        {"color" in props.tint ? (
          <SymbolView
            name="drop.fill"
            size={dropSize}
            tintColor={props.tint.color}
            type="monochrome"
          />
        ) : (
          <SymbolView
            name="drop.fill"
            size={dropSize}
            tintColorClassName={props.tint.className}
            type="monochrome"
          />
        )}
      </Animated.View>
    );
  });
}
