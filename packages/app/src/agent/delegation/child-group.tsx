import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown } from "lucide-react"
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react"
import { useAgentMessages } from "../i18n"
import { ChildCard } from "./child-card"
import { StateGlyph, WorkedFor } from "./child-parts"
import { childrenCost } from "./interpret"
import { type ChildModel, groupSummary, isSettled } from "./model"
import type { ChildrenSource } from "./use-children"

/**
 * Several children of one reply: a line that says how they stand, then a row for each, the ones
 * waiting on the reader first. It is open while any works, waits or will continue, and folds to
 * its line once all have settled, never while the reader has a child's work open. Something new
 * for the reader to do opens it again.
 */
export function ChildGroup({
  models,
  source,
  unavailable,
}: {
  readonly models: readonly ChildModel[]
  readonly source: ChildrenSource
  readonly unavailable: boolean
}) {
  const messages = useAgentMessages()
  const labels = messages.delegation
  const locale = useLocale()
  const listId = useId()

  const [choice, setChoice] = useState<boolean | null>(null)
  const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set())
  const onWorkOpenChange = useCallback((childId: string, open: boolean) => {
    setReading((current) => {
      if (open === current.has(childId)) return current
      const next = new Set(current)
      if (open) next.add(childId)
      else next.delete(childId)
      return next
    })
  }, [])

  const forReader = models.filter((model) => model.needsReader).length
  const asked = useRef(forReader)
  useEffect(() => {
    if (forReader > asked.current) setChoice(null)
    asked.current = forReader
  }, [forReader])

  const settled = models.every((model) => isSettled(model.state))
  const open = choice ?? (!settled || reading.size > 0)
  const summary = groupSummary(models, messages)
  const cost = childrenCost(
    models.map((model) => model.view),
    locale
  )
  // The reader's own to act on come first; the rest keep the order the Agent spawned them in.
  const ordered = [
    ...models.filter((model) => model.needsReader),
    ...models.filter((model) => !model.needsReader),
  ]

  return (
    <section
      aria-label={labels.group}
      data-delegation-group=""
      className={cn(
        "min-w-0 overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        forReader > 0 ? "border-amber-500/35" : "border-border"
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setChoice(!open)}
        className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
      >
        <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
          {models.slice(0, 4).map((model) => (
            <StateGlyph
              key={model.child.id}
              state={model.state}
              calm={!model.needsReader}
              size="sm"
              ringed
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 text-[13px] leading-5">
          <span className="font-semibold whitespace-nowrap text-foreground">
            {labels.count(models.length)}
          </span>
          {/* Each part wraps whole, at the separator before it. */}
          {summary.map((part) => (
            <Fragment key={part.text}>
              <span className="text-muted-foreground"> · </span>
              <span
                className={cn(
                  "whitespace-nowrap text-muted-foreground",
                  part.urgent && "font-medium text-amber-700 dark:text-amber-400"
                )}
              >
                {part.text}
              </span>
            </Fragment>
          ))}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">
          <WorkedFor views={models.map((model) => model.view)} />
          {cost ? ` · ${cost}` : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>

      {open ? null : (
        <span className="sr-only" aria-live="polite">
          {`${labels.count(models.length)} · ${summary.map((part) => part.text).join(" · ")}`}
        </span>
      )}

      {/* Folded, the rows stay mounted: a row keeps its open work and where the reader was. */}
      <ul
        id={listId}
        hidden={!open}
        className="divide-y divide-border/70 border-t border-border/70"
      >
        {ordered.map((model) => (
          <li key={model.child.id}>
            <ChildCard
              model={model}
              source={source}
              unavailable={unavailable}
              grouped
              announce={open}
              onWorkOpenChange={onWorkOpenChange}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}
