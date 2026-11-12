import { createFileRoute } from "@tanstack/react-router";

import { MachinesPage } from "../components/nodeResources/MachinesPage";

export const Route = createFileRoute("/_chat/machines/")({
  component: () => <MachinesPage />,
});
