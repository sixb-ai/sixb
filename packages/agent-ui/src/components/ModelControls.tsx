import type { AgentReasoningLevel } from "@sixb/core"
import { Popover, PopoverContent, PopoverTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import {
  AudioLines,
  Brain,
  Check,
  ChevronDown,
  Eye,
  FileText,
  Gauge,
  Search,
  Shapes,
  Wrench,
} from "lucide-react"
import { useMemo, useState } from "react"
import type { LanguageModel } from "../types"

export interface ModelControlsProps {
  readonly models: readonly LanguageModel[]
  readonly selectedModel?: LanguageModel
  readonly selectedReasoning?: AgentReasoningLevel
  readonly loading?: boolean
  readonly error?: boolean
  readonly disabled?: boolean
  readonly onSelectModel: (model: LanguageModel) => void
  readonly onSelectReasoning: (reasoning: AgentReasoningLevel) => void
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
  const [reasoningOpen, setReasoningOpen] = useState(false)
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

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Popover open={modelOpen} onOpenChange={updateModelOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled || loading || models.length === 0}
            aria-label="Choose model"
            className={cn(
              "flex h-8 min-w-0 max-w-48 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors",
              "hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
              "disabled:cursor-default disabled:opacity-60"
            )}
          >
            {selectedModel ? (
              <ProviderLogo model={selectedModel} className="size-4 p-0.5" />
            ) : (
              <Shapes className="size-4" aria-hidden="true" />
            )}
            <span className="truncate">
              {selectedModel?.name ?? (error ? "Models unavailable" : "Default model")}
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={10}
          className="w-[calc(100vw-1rem)] max-w-[27rem] rounded-2xl p-2 shadow-2xl shadow-black/10"
        >
          <div className="px-2 pt-1 pb-2">
            <p className="text-sm font-semibold text-foreground">Choose a model</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The selection applies to your next message.
            </p>
          </div>
          {models.length > 5 ? (
            <div className="mb-2 flex h-9 items-center gap-2 rounded-xl border border-input bg-background px-3 text-muted-foreground focus-within:ring-2 focus-within:ring-ring/30">
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
          <div className="scrollbar-thin max-h-[min(30rem,70vh)] space-y-1 overflow-y-auto">
            {visibleModels.map((model) => {
              const selected = sameModel(model, selectedModel)
              return (
                <button
                  key={`${model.provider}:${model.modelId}`}
                  type="button"
                  onClick={() => {
                    onSelectModel(model)
                    updateModelOpen(false)
                  }}
                  className={cn(
                    "group flex w-full gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors",
                    "hover:bg-muted/70 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                    selected && "bg-muted/60"
                  )}
                >
                  <ProviderLogo model={model} className="mt-0.5 size-8" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {model.name}
                      </span>
                      {model.isDefault ? (
                        <span className="rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Default
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {model.publisher.name}
                      {model.via ? ` · via ${model.via}` : ""}
                    </span>
                    {model.description ? (
                      <span className="mt-1.5 line-clamp-2 block text-xs leading-4.5 text-muted-foreground/90">
                        {model.description}
                      </span>
                    ) : null}
                    <CapabilityList model={model} />
                  </span>
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {selected ? (
                      <Check className="size-4 text-foreground" aria-hidden="true" />
                    ) : null}
                  </span>
                </button>
              )
            })}
            {visibleModels.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                No matching models.
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {selectedModel && selectedModel.reasoningLevels.length > 1 && selectedReasoning ? (
        <Popover open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Choose reasoning effort"
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors",
                "hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                "disabled:cursor-default disabled:opacity-60"
              )}
            >
              <Brain className="size-3.5" aria-hidden="true" />
              <span>{reasoningLabel(selectedReasoning)}</span>
              <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            sideOffset={10}
            className="w-64 rounded-2xl p-2 shadow-2xl shadow-black/10"
          >
            <div className="px-2 pt-1 pb-2">
              <p className="text-sm font-semibold text-foreground">Reasoning effort</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Balance speed and depth.</p>
            </div>
            <div className="space-y-0.5">
              {selectedModel.reasoningLevels.map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() => {
                    onSelectReasoning(level)
                    setReasoningOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40",
                    level === selectedReasoning && "bg-muted/60"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {reasoningLabel(level)}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {reasoningDescription(level)}
                    </span>
                  </span>
                  {level === selectedReasoning ? (
                    <Check className="size-4 shrink-0" aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

function ProviderLogo({ model, className }: { model: LanguageModel; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const logoUrl = model.publisher.logoUrl
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/5 bg-white p-1 shadow-xs",
        className
      )}
    >
      {logoUrl && logoUrl !== failedUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="size-full object-contain"
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(logoUrl)}
        />
      ) : (
        <span className="text-[0.55em] font-bold text-neutral-700">
          {model.publisher.name.charAt(0).toUpperCase()}
        </span>
      )}
    </span>
  )
}

function CapabilityList({ model }: { model: LanguageModel }) {
  const capabilities = [
    model.capabilities.input.includes("image") ? { label: "Vision", icon: Eye } : null,
    model.capabilities.input.includes("pdf") ? { label: "PDF", icon: FileText } : null,
    model.capabilities.input.includes("audio") ? { label: "Audio", icon: AudioLines } : null,
    model.capabilities.tools ? { label: "Tools", icon: Wrench } : null,
    model.capabilities.reasoning ? { label: "Reasoning", icon: Brain } : null,
    model.capabilities.contextWindowTokens
      ? {
          label: `${formatTokenCount(model.capabilities.contextWindowTokens)} context`,
          icon: Gauge,
        }
      : null,
  ].filter((capability) => capability !== null)

  if (capabilities.length === 0) return null
  return (
    <span className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1">
      {capabilities.map(({ label, icon: Icon }) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground"
        >
          <Icon className="size-3" aria-hidden="true" />
          {label}
        </span>
      ))}
    </span>
  )
}

function sameModel(left: LanguageModel, right: LanguageModel | undefined): boolean {
  return left.provider === right?.provider && left.modelId === right.modelId
}

function reasoningLabel(level: AgentReasoningLevel): string {
  if (level === "provider-default") return "Default"
  if (level === "xhigh") return "Extra high"
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}

function reasoningDescription(level: AgentReasoningLevel): string {
  switch (level) {
    case "provider-default":
      return "Use the model provider's default"
    case "none":
      return "Answer without extended reasoning"
    case "minimal":
    case "low":
      return "Faster for straightforward work"
    case "medium":
      return "A balanced level for most tasks"
    case "high":
    case "xhigh":
      return "More depth for complex tasks"
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}
