import { cn } from "@sixb/ui/lib/utils"
import type { ComponentType, ReactNode } from "react"

type Icon = ComponentType<{ readonly className?: string }>

/** One step of the trail: its mark on the line, a small label, and what it says. */
export function TrailStep({
  icon: Icon,
  label,
  emphasis = false,
  muted = false,
  children,
}: {
  readonly icon: Icon
  readonly label?: ReactNode
  /** The step that decided the value. */
  readonly emphasis?: boolean
  readonly muted?: boolean
  readonly children: ReactNode
}) {
  return (
    <li className="group relative flex gap-3.5 pb-7 last:pb-0">
      <span
        aria-hidden
        className="absolute top-8 bottom-1 left-[0.8125rem] w-px bg-border group-last:hidden"
      />
      <span
        aria-hidden
        className={cn(
          "relative flex size-[1.625rem] shrink-0 items-center justify-center rounded-full",
          emphasis
            ? "bg-foreground text-background shadow-[0_1px_2px_0_rgb(0_0_0/0.12)]"
            : "border border-border bg-background text-muted-foreground",
          muted && "border-dashed"
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className={cn("min-w-0 flex-1", label ? "pt-px" : "pt-1")}>
        {label ? (
          <p className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">{label}</p>
        ) : null}
        {children}
      </div>
    </li>
  )
}

/** A step the walk upstream is still reading. */
export function PendingStep() {
  return (
    <li className="flex gap-3.5 pb-7 last:pb-0">
      <span
        aria-hidden
        className="size-[1.625rem] shrink-0 animate-pulse rounded-full border border-border bg-muted"
      />
      <span className="flex flex-1 flex-col gap-2 pt-1.5">
        <span className="h-2.5 w-24 animate-pulse rounded bg-muted" />
        <span className="h-3 w-44 max-w-full animate-pulse rounded bg-muted/70" />
      </span>
    </li>
  )
}

export function ColumnName({ name }: { readonly name: string }) {
  return (
    <code className="rounded-[5px] bg-muted px-1.5 py-px font-mono text-[0.6875rem] text-foreground/80">
      {name}
    </code>
  )
}
