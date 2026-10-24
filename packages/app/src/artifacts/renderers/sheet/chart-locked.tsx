import { cn } from "@sixb/ui/lib/utils"
import { Lock } from "lucide-react"

/**
 * In place of a chart that would draw from values the reader may not see: a lock, and why, filling
 * the chart's space. `compact` keeps to the lock, for a card's small chart.
 */
export function ChartLocked({
  label,
  compact = false,
}: {
  readonly label: string
  readonly compact?: boolean
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-locked=""
      className="flex size-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground"
    >
      <Lock
        className={cn("shrink-0 text-muted-foreground/70", compact ? "size-3.5" : "size-5")}
        aria-hidden="true"
      />
      {compact ? null : <span>{label}</span>}
    </span>
  )
}
