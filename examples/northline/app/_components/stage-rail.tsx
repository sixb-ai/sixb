import { cn } from "@sixb/ui/lib/utils"

/** A record's stages as a thin rail: done in ink, current in the accent, the rest quiet. */
export function StageRail({
  stages,
  current,
  progress,
}: {
  stages: ReadonlyArray<{ readonly id: string; readonly label: string }>
  current: string
  /** How far through the current stage, from 0 to 1. */
  progress?: number
}) {
  const currentIndex = Math.max(
    0,
    stages.findIndex((stage) => stage.id === current)
  )
  const currentStage = stages[currentIndex]
  return (
    <div className="flex flex-col gap-2">
      <ol
        aria-label="Stage"
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
      >
        {stages.map((stage, index) => {
          const done = index < currentIndex
          const active = index === currentIndex
          return (
            <li
              key={stage.id}
              aria-current={active ? "step" : undefined}
              className="flex min-w-0 flex-col gap-2"
            >
              <span className="relative block h-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full",
                    done ? "w-full bg-foreground" : active ? "bg-primary" : "w-0"
                  )}
                  style={active ? { width: `${Math.round((progress ?? 1) * 100)}%` } : undefined}
                />
              </span>
              <span
                className={cn(
                  "truncate text-[12.5px] max-sm:sr-only",
                  active
                    ? "font-semibold text-primary"
                    : done
                      ? "font-medium text-foreground/80"
                      : "text-muted-foreground"
                )}
              >
                {stage.label}
              </span>
            </li>
          )
        })}
      </ol>
      {/* Seven labels don't fit a phone's width; it names the current stage once instead. */}
      <p className="text-[13px] sm:hidden">
        <span className="font-semibold text-primary">{currentStage?.label}</span>
        <span className="text-muted-foreground">
          {" "}
          · {currentIndex + 1} of {stages.length}
        </span>
      </p>
    </div>
  )
}
