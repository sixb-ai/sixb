import type { SixbFailure } from "@sixb/core"
import { cn } from "@sixb/ui/lib/utils"

export function SixbFailureSummary({
  failure,
  className,
  truncateMessage = false,
}: {
  failure: Pick<SixbFailure, "code" | "message">
  className?: string
  truncateMessage?: boolean
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p
        className={cn("text-destructive", truncateMessage ? "truncate" : "break-words")}
        title={truncateMessage ? failure.message : undefined}
      >
        {failure.message}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{failure.code}</p>
    </div>
  )
}
