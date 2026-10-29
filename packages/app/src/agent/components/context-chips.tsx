import {
  type AgentContextEntryInput,
  type AgentContextInput,
  agentContextIdentity,
} from "@sixb/core/agents/context"
import { cn } from "@sixb/ui/lib/utils"
import { Box, PanelsTopLeft, X } from "lucide-react"
import { useAgentMessages } from "../i18n"
import { useAgentContextLabel } from "../object-context-title"

/** A context or attachment chip: a framed icon, the name, and a remove button in the composer. */
export const COMPOSER_CHIP_CLASS_NAME =
  "inline-flex h-8 max-w-[min(100%,20rem)] items-center gap-2 rounded-[11px] bg-black/[0.045] pl-[7px] text-[13px] text-foreground dark:bg-white/[0.08]"

/** A chip's framed icon. */
export const COMPOSER_CHIP_THUMB_CLASS_NAME =
  "flex size-5 shrink-0 items-center justify-center rounded-md bg-background text-foreground/75 shadow-[0_0_0_0.5px_rgb(0_0_0/0.12)] dark:bg-white/[0.1] dark:shadow-none"

export const COMPOSER_CHIP_REMOVE_CLASS_NAME =
  "flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-black/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 dark:hover:bg-white/[0.1]"

export interface ContextChipsProps {
  readonly entries: readonly AgentContextEntryInput[]
  /** Shows a remove button on each chip. */
  readonly onRemove?: (index: number) => void
  readonly className?: string
}

export function ContextChips({ entries, onRemove, className }: ContextChipsProps) {
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
    <span className={cn(COMPOSER_CHIP_CLASS_NAME, onRemove ? "pr-1.5" : "pr-2.5")}>
      <span className={COMPOSER_CHIP_THUMB_CLASS_NAME}>
        {context.kind === "object" ? (
          <Box className="size-3" strokeWidth={2} aria-hidden="true" />
        ) : (
          <PanelsTopLeft className="size-3" strokeWidth={2} aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className={COMPOSER_CHIP_REMOVE_CLASS_NAME}
          aria-label={messages.remove(label)}
        >
          <X className="size-[11px]" strokeWidth={2.6} />
        </button>
      ) : null}
    </span>
  )
}
