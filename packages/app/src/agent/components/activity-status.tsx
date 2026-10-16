import { cn } from "@sixb/ui/lib/utils"
import { useEffect, useMemo, useState } from "react"
import { useAgentMessages } from "../i18n"
import { type AgentMessages, en } from "../i18n/en"

export const ACTIVITY_STATUS_ROW_CLASS_NAME =
  "group flex w-fit max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] leading-normal text-muted-foreground"

interface ActivityStatusStep {
  readonly afterMs: number
  readonly label: string
}

function thinkingSteps(messages: AgentMessages["activity"]): readonly ActivityStatusStep[] {
  return [
    { afterMs: 0, label: messages.thinking },
    { afterMs: 8_000, label: messages.workingThroughIt },
    { afterMs: 20_000, label: messages.closerLook },
    { afterMs: 35_000, label: messages.checkingDetails },
    { afterMs: 55_000, label: messages.stillWorking },
  ]
}

const CONTINUING_STATUS_DELAY_MS = 12_000

/**
 * Return honest activity copy for an indeterminate wait. Thinking gets a few calm, neutral updates;
 * a known operation keeps its real current-step label and only adds "Still" after a long wait.
 */
export function activityStatusAt(
  label: string,
  elapsedMs: number,
  messages: AgentMessages["activity"] = en.activity
): string {
  const steps = activityStatusSteps(label, messages)
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
  const messages = useAgentMessages().activity
  const steps = useMemo(() => activityStatusSteps(label, messages), [label, messages])
  const [elapsed, setElapsed] = useState({ label, elapsedMs: 0 })
  // A real activity change resets immediately during render, before the effect replaces timers.
  const elapsedMs = elapsed.label === label ? elapsed.elapsedMs : 0
  const currentLabel = activityStatusAt(label, elapsedMs, messages)

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

function activityStatusSteps(
  label: string,
  messages: AgentMessages["activity"]
): readonly ActivityStatusStep[] {
  if (label === messages.thinking) return thinkingSteps(messages)
  return [
    { afterMs: 0, label },
    { afterMs: CONTINUING_STATUS_DELAY_MS, label: messages.still(label) },
  ]
}
