import { MachineSection } from "../primitives/MachineSection";

/** The at-a-glance grids: one cell per core, then the memory and VRAM pools. */
export function TaskManagerGrids() {
  return (
    <div className="grid grid-cols-1 gap-3 @2xl/task-manager:grid-cols-3">
      <MachineSection title="Cores">{null}</MachineSection>
      <MachineSection title="Memory">{null}</MachineSection>
      <MachineSection title="VRAM">{null}</MachineSection>
    </div>
  );
}
