import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Info } from "lucide-react"
import { useId, useState } from "react"
import type { LanguageModel } from "../types"
import { ProviderLogo } from "./ProviderLogo"

export function ModelPickerRow({
  model,
  selected,
  disabled,
  onSelect,
}: {
  model: LanguageModel
  selected: boolean
  disabled?: boolean
  onSelect: (model: LanguageModel) => void
}) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  return (
    <div className={cn("flex items-center rounded-lg", selected && "bg-muted/60")}>
      <HoverCard open={detailsOpen} onOpenChange={setDetailsOpen} openDelay={350} closeDelay={150}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-describedby={detailsOpen ? detailsId : undefined}
            onFocus={(event) => {
              if (!event.currentTarget.matches(":focus-visible")) event.preventDefault()
            }}
            onClick={() => {
              setDetailsOpen(false)
              onSelect(model)
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
          >
            <ProviderLogo model={model} className="size-5" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {model.name}
            </span>
            <span className="flex size-5 shrink-0 items-center justify-center">
              {selected ? <Check className="size-4 text-foreground" aria-hidden="true" /> : null}
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          id={detailsId}
          role="tooltip"
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={8}
          onEscapeKeyDown={(event) => {
            event.stopPropagation()
            setDetailsOpen(false)
          }}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-2xl border-border/60 p-4 shadow-xl shadow-black/10"
        >
          <ModelDetails model={model} />
        </HoverCardContent>
      </HoverCard>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Details about ${model.name}`}
            className="mr-1 hidden size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 [@media(pointer:coarse)]:flex"
          >
            <Info className="size-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          aria-label={`Details about ${model.name}`}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-2xl border-border/60 p-4 shadow-xl shadow-black/10"
        >
          <ModelDetails model={model} />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function ModelDetails({ model }: { model: LanguageModel }) {
  const capabilities = [
    model.capabilities.input.includes("image") && "Images",
    model.capabilities.input.includes("pdf") && "PDF",
    model.capabilities.input.includes("audio") && "Audio",
    model.capabilities.input.includes("video") && "Video",
    model.capabilities.tools && "Tools",
    model.capabilities.reasoning && "Reasoning",
  ].filter(Boolean)

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <ProviderLogo model={model} className="mt-0.5 size-5" />
        <p className="min-w-0 text-sm font-medium leading-5 text-foreground">{model.name}</p>
      </div>
      {model.description ? (
        <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">{model.description}</p>
      ) : null}
      {model.capabilities.contextWindowTokens ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="text-muted-foreground">Context window</span>
          <span className="text-foreground">
            {model.capabilities.contextWindowTokens.toLocaleString("en-US")} tokens
          </span>
        </div>
      ) : null}
      {capabilities.length > 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{capabilities.join(" · ")}</p>
      ) : null}
      {model.via ? <p className="text-[11px] text-muted-foreground/70">Via {model.via}</p> : null}
    </div>
  )
}
