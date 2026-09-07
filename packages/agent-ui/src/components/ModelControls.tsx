import type { ModelReasoningLevel } from "@sixb/core/models"
import { Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown, Search, Shapes } from "lucide-react"
import { useMemo, useState } from "react"
import type { LanguageModel } from "../types"
import { ModelPickerRow } from "./ModelPickerRow"
import { modelDisplayName, reasoningLabel } from "./model-picker-labels"
import { ProviderLogo } from "./ProviderLogo"
import { ReasoningEffortSlider } from "./ReasoningEffortSlider"

export interface ModelControlsProps {
  readonly models: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: ModelReasoningLevel
  readonly loading?: boolean
  readonly error?: boolean
  readonly disabled?: boolean
  readonly onSelectModel: (model: LanguageModel) => void
  readonly onSelectReasoning: (reasoning: ModelReasoningLevel) => void
}

export function ModelControls({
  models,
  selectedModel,
  selectedReasoning,
  loading,
  error,
  disabled,
  onSelectModel,
  onSelectReasoning,
}: ModelControlsProps) {
  const [modelOpen, setModelOpen] = useState(false)
  const [query, setQuery] = useState("")
  const normalizedQuery = query.trim().toLowerCase()
  const hasReasoning =
    selectedModel && selectedModel.reasoningLevels.length > 1 && selectedReasoning
  const visibleModels = useMemo(() => {
    if (!normalizedQuery) return models
    return models.filter((model) =>
      [modelDisplayName(model), model.name, model.publisher.name, model.modelId, model.via]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedQuery))
    )
  }, [models, normalizedQuery])

  const updateModelOpen = (open: boolean) => {
    setModelOpen(open)
    if (!open) setQuery("")
  }

  return (
    <div className="flex min-w-0">
      <Popover open={modelOpen} onOpenChange={updateModelOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled || loading || models.length === 0}
            aria-label="Choose model and reasoning effort"
            className={cn(
              "flex h-8 min-w-0 max-w-72 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors",
              "hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
              "disabled:cursor-default disabled:opacity-60",
              modelOpen && "bg-muted/60 text-foreground"
            )}
          >
            {selectedModel ? (
              <ProviderLogo model={selectedModel} className="size-4" />
            ) : (
              <Shapes className="size-4" aria-hidden="true" />
            )}
            <span className="truncate text-foreground" title={selectedModel?.name}>
              {selectedModel
                ? modelDisplayName(selectedModel)
                : error
                  ? "Models unavailable"
                  : "Default model"}
            </span>
            {hasReasoning ? (
              <span className="shrink-0 text-muted-foreground">
                {reasoningLabel(selectedReasoning)}
              </span>
            ) : null}
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={10}
          collisionPadding={8}
          aria-label="Model and reasoning effort"
          className="flex max-h-[var(--radix-popover-content-available-height)] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-2xl p-0 shadow-xl shadow-black/10"
        >
          {models.length > 5 ? (
            <div className="m-1.5 mb-0 flex h-9 shrink-0 items-center gap-2 rounded-lg bg-muted/50 px-2.5 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/30">
              <Search className="size-3.5 shrink-0" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models"
                aria-label="Search models"
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}
          <div
            className="scrollbar-thin min-h-0 max-h-[min(22rem,50dvh)] space-y-0.5 overflow-y-auto p-1.5"
            role="group"
            aria-label="Models"
          >
            {visibleModels.map((model) => (
              <ModelPickerRow
                key={`${model.provider}:${model.modelId}`}
                model={model}
                selected={sameModel(model, selectedModel)}
                disabled={disabled}
                onSelect={onSelectModel}
              />
            ))}
            {visibleModels.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                No matching models.
              </p>
            ) : null}
          </div>
          {hasReasoning ? (
            <div className="shrink-0 border-t border-border/60 px-4 py-2.5">
              <ReasoningEffortSlider
                model={selectedModel}
                value={selectedReasoning}
                disabled={disabled}
                onChange={onSelectReasoning}
              />
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function sameModel(left: LanguageModel, right: LanguageModel | undefined): boolean {
  return left.provider === right?.provider && left.modelId === right.modelId
}
