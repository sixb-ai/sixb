import type { ModelReasoningLevel } from "@sixb/core/models"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown, Search, Shapes } from "lucide-react"
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useMemo, useState } from "react"
import { useAgentMessages } from "../i18n"
import type { AgentMessages } from "../i18n/en"
import { defaultLanguageModel, defaultReasoningLevel, hasTiers } from "../model-selection"
import type { LanguageModel } from "../types"
import { AutoModelChip } from "./auto-model-chip"
import {
  COMPOSER_MENU_SECTION_CLASS_NAME,
  COMPOSER_TRIGGER_CLASS_NAME,
  ComposerMenu,
  ComposerMenuScroll,
} from "./composer-menu"
import { ModelPickerRow } from "./model-picker-row"
import { ProviderLogo } from "./provider-logo"
import { ReasoningEffortSlider } from "./reasoning-effort-slider"

export interface ModelControlsProps {
  readonly models: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  readonly loading?: boolean
  readonly error?: boolean
  readonly disabled?: boolean
  readonly onSelectModel: (model: LanguageModel) => void
  readonly onSelectReasoning: (reasoning: ModelReasoningLevel) => void
  /** Return to the selected model's default reasoning. */
  readonly onResetReasoning?: () => void
  /** The selection follows the project defaults: nothing was chosen explicitly. */
  readonly usingDefault?: boolean
  /** Forget the explicit choice and follow the project defaults again; with tiers, Auto. */
  readonly onResetToDefault?: () => void
  /** With tiers: a decision model picks each message's model on Auto. */
  readonly routing?: boolean
}

/**
 * The model picker. With tiers and `onResetToDefault`, an Auto chip: no `selectedModel` is Auto,
 * and choosing a model pins it.
 */
export function ModelControls(props: ModelControlsProps) {
  const { models, onResetToDefault } = props
  if (!hasTiers(models) || !onResetToDefault) return <ModelListControls {...props} />

  return (
    <AutoModelChip
      models={models}
      selectedModel={props.selectedModel}
      selectedReasoning={props.selectedReasoning}
      routing={props.routing}
      disabled={props.disabled || props.loading}
      onSelectModel={props.onSelectModel}
      onSelectReasoning={props.onSelectReasoning}
      onResetReasoning={props.onResetReasoning}
      onChooseAuto={onResetToDefault}
    />
  )
}

function ModelListControls({
  models,
  selectedModel,
  selectedReasoning,
  loading,
  error,
  disabled,
  onSelectModel,
  onSelectReasoning,
  onResetReasoning,
  usingDefault = false,
  onResetToDefault,
}: ModelControlsProps) {
  const agentMessages = useAgentMessages()
  const messages = agentMessages.models
  const [modelOpen, setModelOpen] = useState(false)
  const defaultModel = defaultLanguageModel(models)
  const defaultSummary = defaultModel
    ? modelSummary(defaultModel, agentMessages.reasoning)
    : undefined
  const [query, setQuery] = useState("")
  const normalizedQuery = query.trim().toLowerCase()
  const visibleModels = useMemo(() => {
    if (!normalizedQuery) return models
    return models.filter((model) =>
      [model.name, model.publisher.name, model.modelId, model.via]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedQuery))
    )
  }, [models, normalizedQuery])

  const updateModelOpen = (open: boolean) => {
    setModelOpen(open)
    if (!open) setQuery("")
  }

  // The default model's row follows the project default again instead of pinning that model.
  const choose = (model: LanguageModel) => {
    if (onResetToDefault && !usingDefault && defaultModel && sameModel(model, defaultModel)) {
      onResetToDefault()
    } else {
      onSelectModel(model)
    }
  }

  return (
    <ComposerMenu
      open={modelOpen}
      onOpenChange={updateModelOpen}
      title={messages.popover}
      align="end"
      trigger={
        <ModelTrigger
          name={
            selectedModel
              ? selectedModel.name
              : error
                ? messages.unavailable
                : messages.defaultModel
          }
          icon={
            selectedModel ? (
              <ProviderLogo model={selectedModel} className="size-4" />
            ) : (
              <Shapes className="size-4 shrink-0" aria-hidden="true" />
            )
          }
          level={reasoningLabel(selectedModel, selectedReasoning, agentMessages.reasoning)}
          open={modelOpen}
          disabled={disabled || loading || models.length === 0}
          aria-label={messages.choose}
          title={
            usingDefault && defaultSummary
              ? messages.defaultSummary(defaultSummary)
              : selectedModel?.name
          }
        />
      }
    >
      {/* A short catalog is a list to scan; a long one is searched. */}
      {models.length > 10 ? (
        <div className="mx-4 mt-2 flex h-9 shrink-0 items-center gap-2 border-b border-black/[0.06] text-muted-foreground focus-within:border-foreground/30 dark:border-white/[0.07]">
          <Search className="size-3.5 shrink-0" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={messages.search}
            aria-label={messages.search}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      ) : null}
      <ComposerMenuScroll
        className="flex-1 overscroll-contain p-1.5"
        role="group"
        aria-label={messages.list}
      >
        {visibleModels.map((model) => (
          <ModelPickerRow
            key={`${model.provider}:${model.modelId}`}
            model={model}
            selected={sameModel(model, selectedModel)}
            disabled={disabled}
            note={defaultModel && sameModel(model, defaultModel) ? messages.default : undefined}
            onSelect={choose}
          />
        ))}
        {visibleModels.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">{messages.empty}</p>
        ) : null}
      </ComposerMenuScroll>
      {selectedModel && selectedReasoning ? (
        <div className={COMPOSER_MENU_SECTION_CLASS_NAME}>
          <ReasoningEffortSlider
            model={selectedModel}
            value={selectedReasoning}
            disabled={disabled}
            onChange={onSelectReasoning}
            onReset={onResetReasoning}
          />
        </div>
      ) : null}
    </ComposerMenu>
  )
}

/**
 * The composer's model control: the model's logo and name, its thinking level in muted text, and
 * a chevron, as quiet text that fills only when hovered or open.
 */
export const ModelTrigger = forwardRef<
  HTMLButtonElement,
  {
    readonly icon: ReactNode
    readonly name: string
    readonly level?: string
    readonly open: boolean
  } & ComponentPropsWithoutRef<"button">
>(function ModelTrigger({ icon, name, level, open, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={open}
      {...props}
      className={cn(COMPOSER_TRIGGER_CLASS_NAME, className)}
    >
      {icon}
      <span className="max-w-[11rem] truncate text-foreground max-sm:max-w-[7rem]">{name}</span>
      {level ? <span className="shrink-0 text-muted-foreground">{level}</span> : null}
      <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
    </button>
  )
})

/** The trigger's level: an explicit one the model offers a choice of. */
export function reasoningLabel(
  model: LanguageModel | undefined,
  reasoning: ModelReasoningLevel | undefined,
  messages: AgentMessages["reasoning"]
): string | undefined {
  if (!model || model.reasoningLevels.length <= 1 || !reasoning) return undefined
  if (reasoning === "none" || reasoning === "provider-default") return undefined
  return messages.levels[reasoning]
}

/** "<model> · <level>", omitting a level the provider chooses. */
function modelSummary(model: LanguageModel, messages: AgentMessages["reasoning"]): string {
  const reasoning = defaultReasoningLevel(model)
  return reasoning === undefined || reasoning === "provider-default"
    ? model.name
    : `${model.name} · ${messages.levels[reasoning]}`
}

export function sameModel(left: LanguageModel, right: LanguageModel | undefined): boolean {
  return left.provider === right?.provider && left.modelId === right.modelId
}
