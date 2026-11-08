import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * A titled card in the task manager (cores, memory, VRAM, process lists). `detail` is numbers only:
 * no reassurance copy while the machine is ok.
 */
export function MachineSection({
  title,
  detail,
  actions,
  tripped = false,
  className,
  children,
}: {
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  /** Marks the section whose rule tripped the verdict. */
  readonly tripped?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-tripped={tripped || undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 data-tripped:border-(--machine-stress)/50",
        className,
      )}
    >
      <header className="flex min-w-0 items-center gap-2 text-xs">
        <h3 className="shrink-0 font-semibold">{title}</h3>
        {detail === undefined ? null : (
          <span className="min-w-0 truncate text-muted-foreground tabular-nums">{detail}</span>
        )}
        {actions === undefined ? null : (
          <div className="ms-auto flex shrink-0 items-center gap-1">{actions}</div>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * The one line a section shows when it needs an action, such as "Process list needs the resource
 * monitor" or a missing scope. Never used for an ok state.
 */
export function MachineSectionMessage({
  tone = "muted",
  children,
  action,
}: {
  readonly tone?: "muted" | "error";
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-xs",
        tone === "error" ? "text-error-foreground" : "text-muted-foreground",
      )}
    >
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  );
}
