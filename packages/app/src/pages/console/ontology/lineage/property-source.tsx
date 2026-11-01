import { Tooltip, TooltipContent, TooltipTrigger } from "@sixb/ui/components"
import { Activity, Layers, PencilLine } from "lucide-react"
import type { ComponentType, MouseEvent } from "react"
import { humanize, useFormat } from "../../../section-ui"
import { useLineageMessages } from "./messages"
import type { ExplainedProperty, ExplainedSourceKind } from "./model"

// The marks match the pages they lead to: Projections are layers, telemetry a pulse.
const marks: Record<ExplainedSourceKind, ComponentType<{ readonly className?: string }>> = {
  projection: Layers,
  edit: PencilLine,
  telemetry: Activity,
}

/**
 * A property's name with a quiet mark of where its value comes from: imported, edited or set by
 * telemetry. Hovering names the source; pressing it opens the whole trail.
 */
export function PropertySourceLabel({
  label,
  explained,
  onOpen,
}: {
  readonly label: string
  readonly explained: ExplainedProperty
  readonly onOpen: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  const description = useSourceDescription(explained)
  const Mark = marks[explained.source.kind]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={onOpen}
          className="group/source -mx-1 -my-0.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-medium transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="min-w-0 break-words">{label}</span>
          <Mark className="size-3 shrink-0 text-muted-foreground/55 transition-colors group-hover/source:text-foreground/80 group-focus-visible/source:text-foreground/80" />
          <span className="sr-only">, {description}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {description}
      </TooltipContent>
    </Tooltip>
  )
}

/** The source in a few words: "Imported from Billing", "Edited 2 hours ago". */
function useSourceDescription({ source }: ExplainedProperty): string {
  const messages = useLineageMessages().marks
  const format = useFormat()

  if (source.kind === "projection") return messages.projection(humanize(source.projectionId))
  if (source.kind === "edit") return messages.edit(format.relative(source.committedAt))
  return messages.telemetry
}
