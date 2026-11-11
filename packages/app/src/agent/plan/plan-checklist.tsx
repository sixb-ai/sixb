import { cn } from "@sixb/ui/lib/utils"
import { Check } from "lucide-react"
import { useAgentMessages } from "../i18n"
import type { PlanItem, PlanItemStatus } from "./interpret"

/**
 * The plan as its items, in order: a done item checked and quiet, the one in progress set apart,
 * and those to do an empty circle. `live` while the Agent works on it: the item in progress turns.
 */
export function PlanChecklist({
  items,
  live = false,
  className,
}: {
  readonly items: readonly PlanItem[]
  readonly live?: boolean
  readonly className?: string
}) {
  const messages = useAgentMessages().plan
  const statusLabel: Record<PlanItemStatus, string> = {
    completed: messages.completed,
    in_progress: messages.inProgress,
    pending: messages.pending,
  }

  return (
    <ol className={cn("flex flex-col gap-2", className)}>
      {items.map((item, index) => (
        // A plan's items have no identity but their place in it.
        <li
          key={index}
          data-status={item.status}
          className="flex min-w-0 items-start gap-2.5 text-[13px] leading-5"
        >
          <PlanMark status={item.status} live={live} />
          <span
            className={cn(
              "min-w-0 break-words",
              item.status === "completed" && "text-muted-foreground",
              item.status === "in_progress" && "font-medium text-foreground",
              item.status === "pending" && "text-foreground/80"
            )}
          >
            <span className="sr-only">{statusLabel[item.status]}: </span>
            {item.content}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** An item's mark, the size of a line of its text. */
function PlanMark({ status, live }: { readonly status: PlanItemStatus; readonly live: boolean }) {
  if (status === "completed") {
    return (
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/75 text-background"
      >
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
    )
  }

  if (status === "in_progress") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className={cn(
          "mt-0.5 size-4 shrink-0 text-foreground",
          live && "motion-safe:animate-[spin_1.6s_linear_infinite]"
        )}
      >
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1.5"
        />
        {live ? (
          // A quarter of the circle, turning.
          <path
            d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ) : (
          // Half done, at rest: the plan as a call left it.
          <>
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" />
          </>
        )}
      </svg>
    )
  }

  return (
    <span
      aria-hidden="true"
      className="mt-0.5 size-4 shrink-0 rounded-full border-[1.5px] border-muted-foreground/35"
    />
  )
}

/**
 * How far the plan is: a circle that fills like a pie with the items done, so it never reads as
 * the turning mark of the item in progress.
 */
export function PlanProgressRing({
  completed,
  total,
  className,
}: {
  readonly completed: number
  readonly total: number
  readonly className?: string
}) {
  // A pie is a circle stroked as wide as its own diameter: its dash is the share done.
  const radius = 2.75
  const length = 2 * Math.PI * radius
  const done = total > 0 ? Math.min(1, completed / total) : 0

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0 -rotate-90", className)}
    >
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={radius * 2}
        strokeDasharray={length}
        strokeDashoffset={length * (1 - done)}
        className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
      />
    </svg>
  )
}
