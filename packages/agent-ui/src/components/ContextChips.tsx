import { type AgentContextEntryInput, agentContextIdentity } from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { AtSign, Box, PanelsTopLeft, View, X } from "lucide-react"
import { agentContextLabel } from "../utils/contextDisplay"

export function ContextChips({
  entries,
  onRemove,
  className,
}: {
  readonly entries: readonly AgentContextEntryInput[]
  readonly onRemove?: (index: number) => void
  readonly className?: string
}) {
  if (entries.length === 0) return null
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {entries.map((entry, index) => {
        const identity = agentContextIdentity(entry.context)
        return (
          <span
            key={`${identity}:${entry.origin}:${index}`}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/70 py-1 pr-1.5 pl-2 text-xs text-foreground"
          >
            {entry.context.kind === "object" ? (
              <Box className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <PanelsTopLeft
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="truncate">{agentContextLabel(entry.context)}</span>
            <span
              className="inline-flex shrink-0 text-muted-foreground"
              title={entry.origin === "explicit" ? "Added with @" : "Provided by this page"}
              aria-label={entry.origin === "explicit" ? "Added with @" : "Provided by this page"}
            >
              {entry.origin === "explicit" ? (
                <AtSign className="size-3" />
              ) : (
                <View className="size-3" />
              )}
            </span>
            {onRemove ? (
              <button
                type="button"
                onClick={() => onRemove(index)}
                className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
                aria-label={`Remove ${agentContextLabel(entry.context)} context`}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
