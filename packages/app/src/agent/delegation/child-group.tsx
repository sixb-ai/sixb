import { cn } from "@sixb/ui/lib/utils"
import { ChevronRight } from "lucide-react"
import { Fragment, useEffect, useId, useState } from "react"
import { createPortal } from "react-dom"
import { panelTargetKey, type SlotTarget, useArtifactPanel } from "../artifact-panel"
import { useAgentMessages } from "../i18n"
import { ChildAttention, ChildDetail, ChildRow } from "./child-card"
import { AgentAvatar, WorkedFor } from "./child-parts"
import { childTitle, isActive } from "./interpret"
import { type ChildModel, isSettled, lineClauses } from "./model"
import type { ChildrenSource } from "./use-children"

/** How many avatars the line stacks; the sentence names the rest. */
const STACKED = 3

/**
 * The sub-agents of one reply, as one line of it: their avatars, then a sentence that names them and
 * says how they stand ("Terms, History and Disputes finished · 48s"). The line opens them beside the
 * conversation (over the app from the dock, as a sheet on a phone): one straight to its thread,
 * several as a list that opens each. What waits on the reader, its questions and its calls held
 * for approval, stays in the reply under the line.
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
  const panel = useArtifactPanel()
  const inlineId = useId()
  const [first] = models
  const single = models.length === 1 ? first : undefined
  const [chosen, setChosen] = useState<string | null>(null)
  const [inlineOpen, setInlineOpen] = useState(false)

  const slotId = `agents:${source.runId ?? first?.child.id ?? ""}`
  const listTitle = labels.panel(models.length)
  const panelOpen =
    panel !== null && panel.openKey === panelTargetKey({ type: "slot", id: slotId, title: "" })
  const shownId = single ? single.child.id : chosen
  const shown = models.find((model) => model.child.id === shownId)

  const target = (childId: string | null): SlotTarget => {
    const model = models.find((candidate) => candidate.child.id === childId)
    return {
      type: "slot",
      id: slotId,
      title: model ? childTitle(model.child.key) : listTitle,
      ...(model && !single ? { back: { label: labels.back, onBack: () => show(null) } } : {}),
    }
  }
  const show = (childId: string | null) => {
    setChosen(childId)
    if (panel) panel.open(target(childId))
    else setInlineOpen(true)
  }
  const toggle = () => {
    if (!panel) return setInlineOpen((open) => !open)
    if (panelOpen) panel.close()
    else show(single ? single.child.id : null)
  }

  // A list the panel shows keeps its count as children join it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the title follows the count
  useEffect(() => {
    if (panelOpen && !shown && panel) panel.open(target(null))
  }, [models.length])

  const clauses = lineClauses(models, messages)
  const settled = models.every((model) => isSettled(model.state))
  const urgent = clauses.some((clause) => clause.tone === "urgent")
  const firstLive = clauses.find((clause) => clause.tone === "live")
  const live = firstLive !== undefined
  const sentence = clauses
    .map((clause) => [clause.names, clause.verb].filter(Boolean).join(" "))
    .join(" · ")
  // The ones waiting on the reader lead the stack.
  const ordered = [
    ...models.filter((model) => model.needsReader),
    ...models.filter((model) => !model.needsReader),
  ]
  const stack = ordered.slice(0, STACKED)
  const open = panel ? panelOpen : inlineOpen

  const view = shown ? (
    <ChildDetail model={shown} source={source} unavailable={unavailable} />
  ) : (
    <ul className="flex flex-col gap-0.5 pt-1">
      {ordered.map((model) => (
        <li key={model.child.id}>
          <ChildRow
            model={model}
            tint={models.indexOf(model)}
            observed={source.observed}
            onOpen={() => show(model.child.id)}
          />
        </li>
      ))}
    </ul>
  )

  return (
    <section
      aria-label={labels.group}
      data-delegation-group=""
      data-child-state={single?.state}
      className="flex min-w-0 flex-col gap-2"
    >
      {/* Said once per change of how they stand, never per step. */}
      <span className="sr-only" aria-live="polite">
        {sentence}
      </span>

      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel ? undefined : inlineId}
        aria-label={labels.open(sentence || listTitle)}
        onClick={toggle}
        className={cn(
          "group/line -ml-1 flex w-fit max-w-full min-w-0 items-center gap-2.5 rounded-lg px-1 py-1 text-left text-[13px] leading-normal outline-none transition-colors",
          "hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40",
          open && "bg-muted/50"
        )}
      >
        <span className="flex shrink-0 items-center pl-0.5">
          {stack.map((model, index) => (
            <AgentAvatar
              key={model.child.id}
              name={childTitle(model.child.key)}
              state={model.state}
              needsReader={model.needsReader}
              tint={models.indexOf(model)}
              stacked={index > 0}
            />
          ))}
          {models.length > STACKED ? (
            <span
              aria-hidden="true"
              className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-background"
            >
              +{models.length - STACKED}
            </span>
          ) : null}
        </span>
        <span className="min-w-0">
          {clauses.length === 0 ? (
            <span className="text-muted-foreground">{listTitle}</span>
          ) : (
            clauses.map((clause, index) => (
              <Fragment key={`${clause.tone}:${clause.verb}`}>
                {index > 0 ? <span className="text-muted-foreground/60"> · </span> : null}
                {clause.names ? (
                  <span className="font-medium text-foreground/85">{clause.names}</span>
                ) : null}
                {clause.names && clause.verb ? " " : null}
                {clause.verb ? (
                  <span
                    className={cn(
                      "whitespace-nowrap",
                      clause.tone === "urgent" ? "text-foreground/85" : "text-muted-foreground",
                      clause.tone === "live" && "shimmer motion-reduce:animate-none"
                    )}
                  >
                    {clause.verb}
                    {clause.tone === "live" ? "…" : ""}
                  </span>
                ) : null}
                {/* The time belongs to who is at work, or, once all settled, to all of them. */}
                {clause === firstLive ? (
                  <span className="whitespace-nowrap text-muted-foreground/70 tabular-nums">
                    <span className="text-muted-foreground/60"> · </span>
                    <WorkedFor
                      views={models
                        .filter((model) => isActive(model.state))
                        .map((model) => model.view)}
                    />
                  </span>
                ) : null}
              </Fragment>
            ))
          )}
          {settled && !urgent ? (
            <span className="whitespace-nowrap text-muted-foreground/70 tabular-nums">
              <span className="text-muted-foreground/60"> · </span>
              <WorkedFor views={models.map((model) => model.view)} />
            </span>
          ) : null}
        </span>
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground opacity-50 transition-[opacity,transform] group-hover/line:opacity-100 motion-reduce:transition-none",
            !panel && inlineOpen && "rotate-90",
            live && "opacity-40"
          )}
          aria-hidden="true"
        />
      </button>

      {models.map((model) => (
        <ChildAttention
          key={model.child.id}
          model={model}
          observed={source.observed}
          named={models.length > 1}
        />
      ))}

      {panelOpen && panel?.slotHost ? createPortal(view, panel.slotHost) : null}
      {!panel && inlineOpen ? (
        <div id={inlineId} className="rounded-2xl bg-muted/40 px-4 py-3">
          {shown && !single ? (
            <button
              type="button"
              onClick={() => setChosen(null)}
              className="mb-2 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
            >
              ‹ {labels.back}
            </button>
          ) : null}
          {view}
        </div>
      ) : null}
    </section>
  )
}
