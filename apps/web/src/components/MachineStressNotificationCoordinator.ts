import { formatAge, formatMachineReason } from "@t3tools/client-runtime/state/machineFormat";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { EnvironmentId } from "@t3tools/contracts";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { machineIndicator } from "../state/machineResources";
import { environmentSummaries } from "../state/presentation";
import {
  hasDesktopNotifications,
  isAppInForeground,
  showBackgroundNotification,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

function machineStressDescription(indicator: MachineIndicator): string {
  if (!indicator.reason) return "";
  const reason = formatMachineReason(indicator.reason);
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)} for ${formatAge(indicator.reason.heldForMs)}`;
}

/**
 * Tells the user once per episode when a connected machine goes from ok to stressed. The first
 * verdict seen for a machine only sets the baseline, and unknown never moves it.
 */
export function startMachineStressNotifications(): () => void {
  const watched = new Map<EnvironmentId, () => void>();

  const present = (environmentId: EnvironmentId, indicator: MachineIndicator) => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const label =
      appAtomRegistry
        .get(environmentSummaries.identitiesAtom)
        .find((identity) => identity.environmentId === environmentId)?.label ?? "A machine";
    const title = `${label} is stressed`;
    const description = machineStressDescription(indicator);
    if (inAppNotificationsEnabled && isAppInForeground()) {
      toastManager.add({ type: "warning", title, description });
      return;
    }
    if (!hasDesktopNotifications(notificationMode)) return;
    showBackgroundNotification({
      title,
      body: description,
      tag: `machine-stress:${environmentId}`,
    });
  };

  const watch = (environmentId: EnvironmentId) => {
    let lastKnown: "ok" | "stressed" | null = null;
    return appAtomRegistry.subscribe(
      machineIndicator.machineIndicatorAtom(environmentId),
      (indicator) => {
        if (!indicator.show || indicator.unreachable || indicator.verdict === "unknown") return;
        if (lastKnown === "ok" && indicator.verdict === "stressed") {
          present(environmentId, indicator);
        }
        lastKnown = indicator.verdict;
      },
      { immediate: true },
    );
  };

  const sync = () => {
    const { notifyOnMachineStressed, notificationMode, inAppNotificationsEnabled } =
      getClientSettings();
    const enabled =
      notifyOnMachineStressed &&
      (hasDesktopNotifications(notificationMode) || inAppNotificationsEnabled);
    const environmentIds = new Set(
      enabled ? appAtomRegistry.get(environmentSummaries.environmentIdsAtom) : [],
    );
    for (const [environmentId, unsubscribe] of watched) {
      if (environmentIds.has(environmentId)) continue;
      unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watch(environmentId));
    }
  };

  const unsubscribeSettings = subscribeClientSettings(sync);
  const unsubscribeEnvironmentIds = appAtomRegistry.subscribe(
    environmentSummaries.environmentIdsAtom,
    sync,
  );
  sync();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of watched.values()) unsubscribe();
    watched.clear();
  };
}
