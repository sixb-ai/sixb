import { LANGUAGE_MODEL_TIERS, type ModelReasoningLevel } from "@sixb/core/models"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronDown, Sparkles, X } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { useAgentMessages } from "../i18n"
import { defaultLanguageModel } from "../model-selection"
import type { LanguageModel } from "../types"
import { moveRadioFocus } from "../utils/radio-group"
import { ModelPickerRow } from "./model-picker-row"
import { ProviderLogo } from "./provider-logo"
import { ReasoningEffortSlider } from "./reasoning-effort-slider"

export interface AutoModelChipProps {
  readonly models: readonly LanguageModel[]
  /** The model pinned in this conversation; without one, Auto. */
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  /** A decision model picks each message's model on Auto; without one, Auto runs `standard`. */
  readonly routing?: boolean
  readonly disabled?: boolean
  readonly onSelectModel: (model: LanguageModel) => void
  readonly onSelectReasoning: (reasoning: ModelReasoningLevel) => void
  readonly onResetReasoning?: () => void
  /** Forget the conversation's pin, including one whose model left the catalog. */
  readonly onChooseAuto: () => void
}

/**
 * The model choice when `models.language` uses tiers, beside the send button: "Auto" until a
 * model is pinned, then that model with a × back to Auto. The menu lists Auto, then each tier's
 * models; a pinned model's reasoning shows under them. A phone keeps a short label and opens a
 * bottom sheet, as the approval mode chip does.
 */
export function AutoModelChip({
  models,
  selectedModel,
  selectedReasoning,
  routing = false,
  disabled,
  onSelectModel,
  onSelectReasoning,
  onResetReasoning,
  onChooseAuto,
}: AutoModelChipProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.models
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const name = selectedModel?.name ?? messages.auto
  const level =
    selectedModel &&
    selectedModel.reasoningLevels.length > 1 &&
    selectedReasoning &&
    selectedReasoning !== "none" &&
    selectedReasoning !== "provider-default"
      ? agentMessages.reasoning.levels[selectedReasoning]
      : undefined
  const standard = defaultLanguageModel(models)
  const autoDescription =
    routing || !standard ? messages.autoRouting : messages.autoStandard(standard.name)

  const chooseAuto = () => {
    setOpen(false)
    onChooseAuto()
  }

  const trigger = (
    <button
      type="button"
      disabled={disabled || models.length === 0}
      aria-label={messages.chip(level ? `${name} ${level}` : name)}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={selectedModel ? name : autoDescription}
      onClick={mobile ? () => setOpen(true) : undefined}
      className={cn(
        "flex h-9 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium outline-none transition-colors",
        "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-default disabled:opacity-60 max-sm:gap-1 max-sm:px-2",
        open && "bg-muted text-foreground",
        selectedModel && "pr-1.5 text-foreground max-sm:pr-2.5"
      )}
    >
      {selectedModel ? (
        <ProviderLogo model={selectedModel} className="size-4" />
      ) : (
        <Sparkles className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate max-sm:max-w-28">{name}</span>
      {level ? <span className="shrink-0 text-muted-foreground max-sm:hidden">{level}</span> : null}
      {selectedModel ? null : (
        <ChevronDown className="size-3.5 shrink-0 opacity-60 max-sm:hidden" aria-hidden="true" />
      )}
    </button>
  )

  // Pinned, the chip holds its own way back to Auto; a phone goes back from the sheet.
  const chip = (button: ReactNode) =>
    selectedModel ? (
      <div
        className={cn(
          "flex min-w-0 max-w-72 items-center rounded-full bg-muted/60 transition-colors",
          open && "bg-muted"
        )}
      >
        {button}
        <button
          type="button"
          disabled={disabled}
          aria-label={messages.backToAuto}
          title={messages.backToAuto}
          onClick={chooseAuto}
          className="mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 max-sm:hidden"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      </div>
    ) : (
      button
    )

  const menu = (
    <AutoModelMenu
      models={models}
      selectedModel={selectedModel}
      selectedReasoning={selectedReasoning}
      autoDescription={autoDescription}
      disabled={disabled}
      onChooseAuto={chooseAuto}
      onSelectModel={onSelectModel}
      onSelectReasoning={onSelectReasoning}
      onResetReasoning={onResetReasoning}
    />
  )

  if (mobile) {
    return (
      <>
        {chip(trigger)}
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent className="max-h-[85dvh]">
            <div className="px-4 pt-3 pb-1">
              <DrawerTitle className="text-base">{messages.title}</DrawerTitle>
              <DrawerDescription className="sr-only">{autoDescription}</DrawerDescription>
            </div>
            <div className="flex min-h-0 flex-col pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {menu}
            </div>
          </DrawerContent>
        </Drawer>
      </>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        {chip(<PopoverTrigger asChild>{trigger}</PopoverTrigger>)}
      </PopoverAnchor>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={10}
        collisionPadding={8}
        aria-label={messages.title}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl p-0 shadow-xl shadow-black/10"
      >
        <p className="shrink-0 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
          {messages.title}
        </p>
        {menu}
      </PopoverContent>
    </Popover>
  )
}

function AutoModelMenu({
  models,
  selectedModel,
  selectedReasoning,
  autoDescription,
  disabled,
  onChooseAuto,
  onSelectModel,
  onSelectReasoning,
  onResetReasoning,
}: Omit<AutoModelChipProps, "routing"> & { readonly autoDescription: string }) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.models
  const groupId = useId()
  const autoDescriptionId = `${groupId}-auto`
  const auto = selectedModel === undefined
  const tiers = LANGUAGE_MODEL_TIERS.map((tier) => ({
    tier,
    models: models.filter((model) => model.tier === tier),
  })).filter((group) => group.models.length > 0)

  return (
    <>
      {/* Only radios belong to a radio group: each describes itself with its tier's label. */}
      <div
        role="radiogroup"
        aria-label={messages.title}
        onKeyDown={(event) => moveRadioFocus(event)}
        className="scrollbar-thin min-h-0 max-h-[min(26rem,60dvh)] overflow-y-auto p-1.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={auto}
          tabIndex={auto ? 0 : -1}
          aria-describedby={autoDescriptionId}
          disabled={disabled}
          onClick={onChooseAuto}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left outline-none transition-colors",
            "hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
            auto && "bg-muted/60"
          )}
        >
          <Sparkles className="size-5 shrink-0 text-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">{messages.auto}</span>
            <span id={autoDescriptionId} className="mt-0.5 block text-xs text-muted-foreground">
              {autoDescription}
            </span>
          </span>
          <span className="flex size-5 shrink-0 items-center justify-center">
            {auto ? <Check className="size-4 text-foreground" aria-hidden="true" /> : null}
          </span>
        </button>
        {tiers.map((group) => (
          <div key={group.tier}>
            <div
              id={`${groupId}-${group.tier}`}
              className="px-2.5 pt-3 pb-1 text-[11px] font-medium text-muted-foreground/80"
            >
              {agentMessages.delegation.tiers[group.tier]}
            </div>
            <div className="space-y-0.5">
              {group.models.map((model) => (
                <ModelPickerRow
                  key={`${model.provider}:${model.modelId}`}
                  model={model}
                  selected={
                    model.provider === selectedModel?.provider &&
                    model.modelId === selectedModel.modelId
                  }
                  disabled={disabled}
                  radio
                  describedBy={`${groupId}-${group.tier}`}
                  onSelect={onSelectModel}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {selectedModel && selectedModel.reasoningLevels.length > 1 && selectedReasoning ? (
        <div className="shrink-0 border-t border-border/60 px-4 py-2.5">
          <ReasoningEffortSlider
            model={selectedModel}
            value={selectedReasoning}
            disabled={disabled}
            onChange={onSelectReasoning}
            onReset={onResetReasoning}
          />
        </div>
      ) : null}
    </>
  )
}
