import { isSixbApiError } from "@sixb/client"
import { cancelAgentRunByIdMutation } from "@sixb/client/hooks"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ChevronDown, Square, X } from "lucide-react"
import { memo, useEffect, useId, useRef, useState } from "react"
import { childFileSource } from "../../artifacts/file-source"
import { heldCallOf } from "../approvals"
import { ApprovalCard } from "../components/approval-card"
import { FileAttachmentCard } from "../components/file-attachment-card"
import { useAgentMessages } from "../i18n"
import {
  Exchanges,
  ModelChip,
  Section,
  StateGlyph,
  stateLabel,
  statusLabel,
  toneClass,
  WorkedFor,
} from "./child-parts"
import { ChildWork, FollowingScroll } from "./child-work"
import { useDelegationCards } from "./context"
import { type AgentChild, activeRun, childrenCost, childTitle, liveQuestion } from "./interpret"
import type { ChildModel } from "./model"
import { type ChildrenSource, refreshChildren } from "./use-children"

/** How long a failure to stop stays said, unless the reader tries again first. */
const STOP_FAILED_MS = 6_000

/**
 * One child: what it was asked, on which model, where it stands and what it does now. Its work opens
 * right under that, or in a sheet on a phone; below are what passed between it and the Agent, the
 * calls it waits on, and the files it made.
 */
export const ChildCard = memo(function ChildCard({
  model,
  source,
  unavailable,
  grouped = false,
  announce = true,
  onWorkOpenChange,
}: {
  readonly model: ChildModel
  readonly source: ChildrenSource
  readonly unavailable: boolean
  /** A row of a group, which draws the border around it. */
  readonly grouped?: boolean
  /** Say its changes to a screen reader: not while its group is folded. */
  readonly announce?: boolean
  /** Its work opened or closed: a group stays open while any is. */
  readonly onWorkOpenChange?: (childId: string, open: boolean) => void
}) {
  const { child, view, live, state, needsReader } = model
  const messages = useAgentMessages()
  const labels = messages.delegation
  const locale = useLocale()
  const mobile = useIsMobile()
  const cards = useDelegationCards()
  const workId = useId()
  const workButton = useRef<HTMLButtonElement>(null)
  const { runId, observed } = source

  const title = childTitle(child.key)
  const task = view?.task ?? child.task
  const run = activeRun(view)

  const [workOpen, setWorkOpen] = useState(false)
  const openWork = (open: boolean) => {
    setWorkOpen(open)
    onWorkOpenChange?.(child.id, open)
    // A sheet gives the reader back where they were.
    if (!open && mobile) requestAnimationFrame(() => workButton.current?.focus())
  }

  const stop = useStop(model, source)
  const canStop =
    run !== undefined && runId !== null && (cards?.actions?.canStop(run.parentRunId) ?? false)

  const status = statusLabel(model, { stopping: stop.stopping, observed, messages })
  const shownState = stop.stopping ? "stopped" : state
  const cost = childrenCost([view], locale)
  const exchanges = cards?.delegation.exchanges.get(child.id) ?? []
  const openQuestion =
    view?.awaiting?.type === "answer"
      ? view.awaiting.question.text
      : state === "asking" && live
        ? liveQuestion(live.parts)
        : null
  const files = view ? returnedFiles(view) : []
  const hasWork = view !== undefined || unavailable || model.waited?.text !== undefined

  const work = (
    <ChildWork
      view={view}
      live={live}
      source={source}
      unavailable={unavailable}
      waited={model.waited}
      enabled={workOpen}
    />
  )
  const follow = `${live?.parts.length ?? 0}:${view?.runs.length ?? 0}`

  return (
    <section
      aria-label={labels.card(title)}
      data-child-state={state}
      data-child-key={child.key}
      className={cn(
        "min-w-0",
        !grouped &&
          "overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        !grouped &&
          (needsReader
            ? "border-amber-500/35 shadow-[0_0_0_4px_rgb(245_158_11/0.06),0_1px_2px_0_rgb(0_0_0/0.04)]"
            : "border-border")
      )}
    >
      {/* Said once per change of state, never per step: the visible line moves faster. */}
      {announce ? (
        <span className="sr-only" aria-live="polite">
          {`${title}: ${stateLabel(state, model.waitingOn, observed, messages)}`}
        </span>
      ) : null}

      <div className="flex min-w-0 items-start gap-3 px-4 pt-3.5 pb-3">
        <StateGlyph state={shownState} calm={!needsReader} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-[14px] leading-6 font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h3>
            <ModelChip child={child} view={view} className="ml-auto max-sm:hidden" />
          </div>
          {task ? (
            <p
              className={cn(
                "text-[13px] leading-5 text-muted-foreground",
                // The whole task once its work is open, where the reader came to read.
                workOpen && !mobile ? "whitespace-pre-wrap" : "truncate"
              )}
              title={task}
            >
              {task}
            </p>
          ) : null}
          <ModelChip child={child} view={view} className="mt-2 max-w-full sm:hidden" />

          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            {/* What to do never truncates; the facts after it give way first. */}
            <p className="flex min-w-0 flex-1 basis-48 flex-wrap items-baseline gap-x-1.5 text-xs">
              <span
                className={cn(
                  "font-medium break-words",
                  toneClass(shownState, needsReader),
                  state === "working" && !stop.stopping && "shimmer motion-reduce:animate-none"
                )}
              >
                {status}
              </span>
              <span className="min-w-0 truncate text-muted-foreground tabular-nums">
                <WorkedFor views={[view]} />
                {cost ? ` · ${cost}` : null}
              </span>
            </p>

            <div className="ml-auto flex shrink-0 items-center gap-1">
              {model.heldLater ? (
                <button
                  type="button"
                  onClick={() => revealApproval(model.heldLater?.id)}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-amber-700 outline-none transition-colors hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-ring/40 dark:text-amber-400 max-sm:h-9"
                >
                  <ArrowDown className="size-3.5" aria-hidden="true" />
                  {labels.viewRequest}
                </button>
              ) : null}
              {canStop ? (
                <button
                  type="button"
                  onClick={stop.stop}
                  disabled={stop.stopping}
                  aria-label={labels.stopLabel(title)}
                  className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 max-sm:h-9 max-sm:px-2.5"
                >
                  <Square className="size-3 fill-current" aria-hidden="true" />
                  {labels.stop}
                </button>
              ) : null}
              {hasWork ? (
                <button
                  ref={workButton}
                  type="button"
                  aria-expanded={workOpen}
                  aria-controls={mobile ? undefined : workId}
                  aria-haspopup={mobile ? "dialog" : undefined}
                  aria-label={
                    workOpen && !mobile ? labels.hideWorkOf(title) : labels.showWorkOf(title)
                  }
                  onClick={() => openWork(!workOpen)}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-9 max-sm:px-2.5"
                >
                  {workOpen && !mobile ? labels.hideWork : labels.showWork}
                  <ChevronDown
                    className={cn(
                      "size-3.5 transition-transform motion-reduce:transition-none",
                      workOpen && !mobile && "rotate-180",
                      mobile && "-rotate-90"
                    )}
                    aria-hidden="true"
                  />
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {stop.failed ? (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive sm:pl-14">
          {labels.stopFailed}
        </p>
      ) : null}

      {!mobile && workOpen ? (
        <div id={workId} className="border-t border-border/60 bg-muted/25">
          <FollowingScroll
            follow={follow}
            live={run !== undefined}
            className="max-h-[min(28rem,60vh)] px-4 py-3 sm:pl-14"
          >
            {work}
          </FollowingScroll>
        </div>
      ) : null}

      {exchanges.length > 0 || openQuestion ? (
        <Section>
          <Exchanges
            exchanges={exchanges}
            openQuestion={openQuestion}
            urgent={needsReader || state === "asking"}
          />
          {state === "answer" && !observed ? (
            <p className="mt-1.5 text-xs text-muted-foreground">{labels.answerHint}</p>
          ) : null}
        </Section>
      ) : null}

      {model.approvals.length > 0 ? (
        <Section>
          <div className="flex flex-col gap-2.5">
            {model.approvals.map((approval) => (
              <ApprovalCard key={approval.id} held={heldCallOf(approval)} inCard />
            ))}
          </div>
        </Section>
      ) : null}

      {files.length > 0 && view ? (
        <Section label={labels.made}>
          <div className="flex flex-wrap gap-2">
            {files.map(({ runId: fileRunId, path, fileRef }) => (
              <FileAttachmentCard
                key={`${fileRunId}${path}`}
                fileRef={fileRef}
                className="w-[17rem] max-w-full"
                source={childFileSource({
                  threadId: view.threadId,
                  runId: fileRunId,
                  path,
                  fileRef,
                  observed,
                })}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {mobile ? (
        <Drawer open={workOpen} onOpenChange={openWork}>
          <DrawerContent className="data-[vaul-drawer-direction=bottom]:max-h-[88dvh]">
            <div className="flex items-start gap-3 border-b border-border/70 px-4 pt-2 pb-3">
              <StateGlyph state={shownState} calm={!needsReader} />
              <div className="min-w-0 flex-1">
                <DrawerTitle className="truncate text-[15px] font-semibold">{title}</DrawerTitle>
                <DrawerDescription
                  className={cn("text-xs font-medium", toneClass(shownState, needsReader))}
                >
                  {status}
                </DrawerDescription>
              </div>
              <DrawerClose
                aria-label={labels.close}
                className="-mt-0.5 -mr-1.5 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <X className="size-4" aria-hidden="true" />
              </DrawerClose>
            </div>
            <FollowingScroll
              follow={follow}
              live={run !== undefined}
              className="min-h-0 flex-1 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
            >
              {task ? (
                <p className="mb-3 text-[13px] leading-5 whitespace-pre-wrap text-muted-foreground">
                  {task}
                </p>
              ) : null}
              {work}
            </FollowingScroll>
          </DrawerContent>
        </Drawer>
      ) : null}
    </section>
  )
})

/**
 * Stop the child at work, at once: it says it is stopping until its run ends. A failure says so for
 * a moment, and goes once the child ends or the reader tries again.
 */
function useStop(model: ChildModel, source: ChildrenSource) {
  const queryClient = useQueryClient()
  const cancel = useMutation(cancelAgentRunByIdMutation())
  const [stopping, setStopping] = useState(false)
  const [failed, setFailed] = useState(false)
  const run = activeRun(model.view)
  const atWork = run !== undefined

  useEffect(() => {
    if (atWork) return
    setStopping(false)
    setFailed(false)
  }, [atWork])

  useEffect(() => {
    if (!failed) return
    const timer = window.setTimeout(() => setFailed(false), STOP_FAILED_MS)
    return () => window.clearTimeout(timer)
  }, [failed])

  const stop = () => {
    if (source.runId === null || stopping) return
    setStopping(true)
    setFailed(false)
    // Its run at work; before the list has it, the run spawn_agent answered with.
    cancel
      .mutateAsync({ path: { runId: run?.id ?? model.child.id } })
      .then(({ run: stopped }) => {
        void refreshChildren(queryClient, source)
        // A queued run is cancelled at once; a running one ends when its worker obeys.
        if (stopped.status !== "queued" && stopped.status !== "running") setStopping(false)
      })
      .catch((error: unknown) => {
        setStopping(false)
        // Already over: nothing to stop, and its list says how it ended.
        if (isSixbApiError(error) && error.status === 409) {
          void refreshChildren(queryClient, source)
          return
        }
        setFailed(true)
      })
  }

  return { stopping, failed, stop }
}

/** Bring the card of a call held under a later turn into view, and the reader's focus to it. */
function revealApproval(approvalId: string | undefined) {
  if (!approvalId) return
  const card = document.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(approvalId)}"]`)
  if (!card) return
  card.scrollIntoView({ block: "center", behavior: "smooth" })
  card.focus({ preventScroll: true })
}

/** The files its runs returned, each by its run and its place in the run's result. */
function returnedFiles(view: AgentChild) {
  return view.runs.flatMap((run) =>
    (run.result?.files ?? []).map((file, fileIndex) => ({
      runId: run.id,
      path: `/files/${fileIndex}/fileRef`,
      fileRef: file.fileRef,
    }))
  )
}
