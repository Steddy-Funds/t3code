import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { MachinesPage } from "../components/nodeResources/MachinesPage";

function MachineRoute() {
  const { environmentId } = Route.useParams();
  return <MachinesPage environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/_chat/machines/$environmentId")({
  component: MachineRoute,
});
