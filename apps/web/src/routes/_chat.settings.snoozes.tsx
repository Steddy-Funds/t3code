import { createFileRoute } from "@tanstack/react-router";

import { SnoozeHistoryPanel } from "../components/settings/SnoozeHistoryPanel";

export const Route = createFileRoute("/_chat/settings/snoozes")({
  component: SnoozeHistoryPanel,
});
