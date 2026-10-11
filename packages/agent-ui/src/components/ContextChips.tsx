import {
  type AgentContextEntryInput,
  type AgentContextInput,
  agentContextIdentity,
} from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { Box, PanelsTopLeft, X } from "lucide-react"
import { useAgentMessages } from "../i18n"
import { useAgentContextLabel } from "../objectContextTitle"

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
      {entries.map((entry, index) => (
        <ContextChip
          key={`${agentContextIdentity(entry.context)}:${entry.origin}:${index}`}
          context={entry.context}
          onRemove={onRemove ? () => onRemove(index) : undefined}
        />
      ))}
    </div>
  )
}

function ContextChip({
  context,
  onRemove,
}: {
  readonly context: AgentContextInput
  readonly onRemove: (() => void) | undefined
}) {
  const messages = useAgentMessages().context
  const label = useAgentContextLabel(context)
  return (
    <span className="inline-flex max-w-[min(100%,20rem)] items-center gap-1.5 rounded-full border border-border bg-muted/70 py-1 pr-1.5 pl-2 text-xs text-foreground">
      {context.kind === "object" ? (
        <Box className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <PanelsTopLeft className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
          aria-label={messages.remove(label)}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  )
}
