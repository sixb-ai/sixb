import type { ModelReasoningLevel } from "@sixb/core/models"
import { cn } from "@sixb/ui/lib/utils"
import { RotateCcw } from "lucide-react"
import type { CSSProperties } from "react"
import type { LanguageModel } from "../types"
import { reasoningLabel } from "./model-picker-labels"

export function ReasoningEffortSlider({
  model,
  value,
  disabled,
  onChange,
}: {
  model: LanguageModel
  value: ModelReasoningLevel
  disabled?: boolean
  onChange: (level: ModelReasoningLevel) => void
}) {
  const levels: readonly ModelReasoningLevel[] = model.reasoningLevels.filter(
    (level) => level !== "provider-default" && level !== "none" && level !== "minimal"
  )
  const selectedIndex = levels.indexOf(value)
  const index = Math.max(0, selectedIndex)
  const lastIndex = Math.max(0, levels.length - 1)
  const progress = lastIndex > 0 ? index / lastIndex : 0
  const enhanced = value === "max"
  const resetLevel = model.reasoningLevels.includes("provider-default")
    ? "provider-default"
    : model.reasoningLevels[0]

  return (
    <div>
      <div className="relative flex min-h-6 items-center justify-between gap-2 pr-8">
        <span className="text-xs text-muted-foreground">Thinking</span>
        <div className="min-w-0 text-center">
          <span
            title={reasoningDescription(value)}
            className={cn(
              "text-sm font-medium",
              enhanced ? "text-[#007aff] dark:text-[#9ec3ee]" : "text-primary"
            )}
          >
            <span key={value} className="sixb-reasoning-label">
              {reasoningLabel(value)}
            </span>
          </span>
        </div>
        <button
          type="button"
          disabled={disabled || value === resetLevel}
          aria-label="Reset reasoning effort"
          title="Use model default"
          onClick={() => resetLevel && onChange(resetLevel)}
          className="absolute top-1/2 right-0 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div
        data-max={enhanced}
        className="sixb-reasoning-slider"
        hidden={levels.length === 0}
        style={{ "--sixb-reasoning-progress": progress } as CSSProperties}
      >
        <div aria-hidden="true" className="sixb-reasoning-track">
          <div className="sixb-reasoning-fill" />
          <div className="sixb-reasoning-max">
            <div className="sixb-reasoning-sparkles" />
          </div>
          <div className="sixb-reasoning-stops">
            {levels.map((level, stop) => (
              <span
                key={level}
                className="sixb-reasoning-stop"
                data-filled={stop <= selectedIndex}
                style={{ left: `${lastIndex > 0 ? (stop / lastIndex) * 100 : 0}%` }}
              />
            ))}
          </div>
        </div>
        <span aria-hidden="true" className="sixb-reasoning-thumb" />
        <input
          type="range"
          min={0}
          max={lastIndex}
          step={1}
          value={index}
          disabled={disabled}
          aria-label="Reasoning effort"
          aria-valuetext={`${reasoningLabel(value)}: ${reasoningDescription(value)}`}
          onChange={(event) => {
            const level = levels[Number(event.target.value)]
            if (level) onChange(level)
          }}
          onPointerUp={(event) => {
            // The first stop selects its explicit effort when the current value has no stop.
            const level = levels[Number(event.currentTarget.value)]
            if (selectedIndex < 0 && level) onChange(level)
          }}
          onKeyDown={(event) => {
            if (
              selectedIndex < 0 &&
              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
            ) {
              event.preventDefault()
              const level = levels[event.key === "End" ? lastIndex : 0]
              if (level) onChange(level)
            }
          }}
          className="sixb-reasoning-input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
        />
      </div>
    </div>
  )
}

function reasoningDescription(level: ModelReasoningLevel): string {
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
    case "max":
      return "Maximum reasoning depth for the hardest tasks"
  }
}
