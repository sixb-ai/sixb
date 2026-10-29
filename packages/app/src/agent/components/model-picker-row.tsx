import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Info } from "lucide-react"
import { useId, useState } from "react"
import { useAgentMessages } from "../i18n"
import type { LanguageModel } from "../types"
import { COMPOSER_MENU_ROW_CLASS_NAME } from "./composer-menu"
import { ProviderLogo } from "./provider-logo"

export function ModelPickerRow({
  model,
  selected,
  disabled,
  radio = false,
  describedBy,
  tier,
  onSelect,
}: {
  model: LanguageModel
  selected: boolean
  disabled?: boolean
  /** A radio of a radio group. */
  radio?: boolean
  /** The id of what else describes the row, such as its tier's label. */
  describedBy?: string
  /** The tier the row stands for, named at its end when no heading names it. */
  tier?: { readonly id: string; readonly label: string }
  onSelect: (model: LanguageModel) => void
}) {
  const messages = useAgentMessages().models
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  return (
    <div className="flex items-center rounded-xl">
      <HoverCard open={detailsOpen} onOpenChange={setDetailsOpen} openDelay={350} closeDelay={150}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            {...(radio
              ? { role: "radio", "aria-checked": selected, tabIndex: selected ? 0 : -1 }
              : { "aria-pressed": selected })}
            aria-describedby={
              [describedBy, tier?.id, detailsOpen ? detailsId : undefined]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onFocus={(event) => {
              if (!event.currentTarget.matches(":focus-visible")) event.preventDefault()
            }}
            onClick={() => {
              setDetailsOpen(false)
              onSelect(model)
            }}
            // The chosen row's highlight is its wrapper's, which also holds its thinking.
            className={cn(
              COMPOSER_MENU_ROW_CLASS_NAME,
              "flex-1",
              selected && "hover:bg-transparent dark:hover:bg-transparent"
            )}
          >
            <ProviderLogo model={model} className="size-[18px] shrink-0" />
            {/* Just the name: a catalog's description is a paragraph, kept for the details card. */}
            <span
              className={cn("min-w-0 flex-1 truncate text-foreground", selected && "font-medium")}
            >
              {model.name}
            </span>
            {tier?.label ? (
              <span
                id={tier?.id}
                className="shrink-0 text-xs font-normal whitespace-nowrap text-muted-foreground"
              >
                {tier.label}
              </span>
            ) : null}
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
            aria-label={messages.details(model.name)}
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
          aria-label={messages.details(model.name)}
          className="w-72 max-w-[calc(100vw-1rem)] rounded-2xl border-border/60 p-4 shadow-xl shadow-black/10"
        >
          <ModelDetails model={model} />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function ModelDetails({ model }: { model: LanguageModel }) {
  const messages = useAgentMessages().models
  const capabilities = [
    model.capabilities.input.includes("image") && messages.images,
    model.capabilities.input.includes("pdf") && messages.pdf,
    model.capabilities.input.includes("audio") && messages.audio,
    model.capabilities.input.includes("video") && messages.video,
    model.capabilities.tools && messages.tools,
    model.capabilities.reasoning && messages.reasoning,
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
          <span className="text-muted-foreground">{messages.contextWindow}</span>
          <span className="text-foreground">
            {messages.tokens(model.capabilities.contextWindowTokens)}
          </span>
        </div>
      ) : null}
      {capabilities.length > 0 ? (
        <p className="text-xs leading-5 text-muted-foreground">{capabilities.join(" · ")}</p>
      ) : null}
      {model.via ? (
        <p className="text-[11px] text-muted-foreground/70">{messages.via(model.via)}</p>
      ) : null}
    </div>
  )
}
