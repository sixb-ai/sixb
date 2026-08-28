import { cn } from "@sixb/ui/lib/utils"
import { useEffect, useMemo, useState } from "react"

export const ACTIVITY_STATUS_ROW_CLASS_NAME =
  "group flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] leading-normal text-muted-foreground"

interface ActivityStatusStep {
  readonly afterMs: number
  readonly label: string
}

const THINKING_STATUS_STEPS: readonly ActivityStatusStep[] = [
  { afterMs: 0, label: "Thinking" },
  { afterMs: 8_000, label: "Working through it" },
  { afterMs: 20_000, label: "Taking a closer look" },
  { afterMs: 35_000, label: "Checking the details" },
  { afterMs: 55_000, label: "Still working" },
]

const WORKING_STATUS_STEPS: readonly ActivityStatusStep[] = [
  { afterMs: 0, label: "Working" },
  { afterMs: 8_000, label: "Working through it" },
  { afterMs: 20_000, label: "Taking a closer look" },
  { afterMs: 35_000, label: "Checking the details" },
  { afterMs: 55_000, label: "Still working" },
]

const CONTINUING_STATUS_DELAY_MS = 12_000

/**
 * Return honest activity copy for an indeterminate wait. Thinking gets a few calm, neutral updates;
 * a known operation keeps its real current-step label and only adds "Still" after a long wait.
 */
export function activityStatusAt(label: string, elapsedMs: number): string {
  const steps = activityStatusSteps(label)
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step && elapsedMs >= step.afterMs) return step.label
  }
  return label
}

/** Animated status text whose widest phrase reserves the row width, so copy changes never jump. */
export function ActivityStatusText({
  label,
  active = true,
  className,
}: {
  readonly label: string
  readonly active?: boolean
  readonly className?: string
}) {
  const steps = useMemo(() => activityStatusSteps(label), [label])
  const [phase, setPhase] = useState({ label, index: 0 })
  // A real activity change can shorten the timeline. Select its first phrase during render rather
  // than waiting for the effect, otherwise the old index can produce one blank or stale frame.
  const activeIndex = active && phase.label === label ? phase.index : 0

  useEffect(() => {
    setPhase((current) =>
      current.label === label && current.index === 0 ? current : { label, index: 0 }
    )
    if (!active || steps.length < 2) return

    const timers = steps
      .slice(1)
      .map((step, index) =>
        window.setTimeout(() => setPhase({ label, index: index + 1 }), step.afterMs)
      )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [active, steps, label])

  return (
    <span className={cn("inline-grid min-w-0 max-w-full", className)}>
      {steps.map((step, index) => (
        <span
          key={`${step.afterMs}:${step.label}`}
          aria-hidden={index !== activeIndex}
          className={cn(
            "col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-300 motion-reduce:transition-none",
            index === activeIndex ? "opacity-100" : "pointer-events-none opacity-0"
          )}
        >
          {step.label}…
        </span>
      ))}
    </span>
  )
}

function activityStatusSteps(label: string): readonly ActivityStatusStep[] {
  if (label === "Thinking") return THINKING_STATUS_STEPS
  if (label === "Working") return WORKING_STATUS_STEPS
  return [
    { afterMs: 0, label },
    { afterMs: CONTINUING_STATUS_DELAY_MS, label: `Still ${lowercaseFirst(label)}` },
  ]
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value
}
