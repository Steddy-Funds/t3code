import { MachineSection } from "../primitives/MachineSection";

const GRAPHS = ["CPU", "Memory", "Load / core", "GPU"] as const;

/** The four live graphs, each its own fixed-size region so a tick redraws only the charts. */
export function TaskManagerGraphs() {
  return (
    <div className="grid grid-cols-1 gap-3 @2xl/task-manager:grid-cols-2">
      {GRAPHS.map((title) => (
        <MachineSection key={title} title={title}>
          {null}
        </MachineSection>
      ))}
    </div>
  );
}
