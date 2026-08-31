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

/** Render the current status as one visible phrase so adjacent controls stay attached to it. */
export function ActivityStatusText({
  label,
  className,
}: {
  readonly label: string
  readonly className?: string
}) {
  const steps = useMemo(() => activityStatusSteps(label), [label])
  const [elapsed, setElapsed] = useState({ label, elapsedMs: 0 })
  // A real activity change resets immediately during render, before the effect replaces timers.
  const elapsedMs = elapsed.label === label ? elapsed.elapsedMs : 0
  const currentLabel = activityStatusAt(label, elapsedMs)

  useEffect(() => {
    setElapsed((current) =>
      current.label === label && current.elapsedMs === 0 ? current : { label, elapsedMs: 0 }
    )
    if (steps.length < 2) return

    const timers = steps
      .slice(1)
      .map((step) =>
        window.setTimeout(() => setElapsed({ label, elapsedMs: step.afterMs }), step.afterMs)
      )
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [steps, label])

  return <span className={cn("min-w-0 truncate text-left", className)}>{currentLabel}…</span>
}

function activityStatusSteps(label: string): readonly ActivityStatusStep[] {
  if (label === "Thinking") return THINKING_STATUS_STEPS
  return [
    { afterMs: 0, label },
    { afterMs: CONTINUING_STATUS_DELAY_MS, label: `Still ${lowercaseFirst(label)}` },
  ]
}

function lowercaseFirst(value: string): string {
  return value ? `${value[0]?.toLowerCase()}${value.slice(1)}` : value
}
