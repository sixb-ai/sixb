import { cn } from "@sixb/ui/lib/utils"
import type { ReactNode } from "react"

/**
 * Short facts on one line, a dot between each two, that wraps without ever leaving a dot at the
 * end of a line or at the start of the next. Each fact carries its dot before it, and the row is
 * pulled left by that dot's width inside a clipping box: a fact that starts a line has its dot
 * clipped away.
 */
export function SeparatedFacts({
  facts,
  className,
  dotClassName = "text-muted-foreground/50",
}: {
  readonly facts: readonly { readonly key: string; readonly node: ReactNode }[]
  readonly className?: string
  readonly dotClassName?: string
}) {
  return (
    <span className={cn("block min-w-0 overflow-hidden", className)}>
      <span className="-ml-3.5 flex flex-wrap items-center gap-y-1">
        {facts.map((fact) => (
          <span key={fact.key} className="relative inline-flex min-w-0 items-center pl-3.5">
            <span aria-hidden className={cn("absolute left-[0.3125rem]", dotClassName)}>
              ·
            </span>
            {fact.node}
          </span>
        ))}
      </span>
    </span>
  )
}
