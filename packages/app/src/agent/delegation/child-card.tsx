import { isSixbApiError } from "@sixb/client"
import { cancelAgentRunByIdMutation } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"
import { childFileSource } from "../../artifacts/file-source"
import { latestWorkLabel } from "../activity-label"
import { heldCallOf } from "../approvals"
import { ApprovalCard } from "../components/approval-card"
import { FileAttachmentCard } from "../components/file-attachment-card"
import { useAgentMessages } from "../i18n"
import {
  AgentAvatar,
  Exchanges,
  ModelChip,
  NEEDS_READER_TEXT,
  statusLabel,
  WorkedFor,
} from "./child-parts"
import { ChildWork } from "./child-work"
import { useDelegationCards } from "./context"
import { type AgentChild, activeRun, childTitle, liveQuestion } from "./interpret"
import type { ChildModel } from "./model"
import { type ChildrenSource, refreshChildren } from "./use-children"

/** How long a failure to stop stays said, unless the reader tries again first. */
const STOP_FAILED_MS = 6_000

/**
 * A sub-agent in its reply's list of them: its avatar, its name, and on a second line what it does
 * now or how it ended. Choosing it opens its thread.
 */
export function ChildRow({
  model,
  tint,
  observed,
  onOpen,
}: {
  readonly model: ChildModel
  /** Its place among its reply's agents, which picks its avatar's tint. */
  readonly tint: number
  readonly observed: boolean
  readonly onOpen: () => void
}) {
  const messages = useAgentMessages()
  const { child, view, state, needsReader } = model
  const title = childTitle(child.key)
  const task = view?.task ?? child.task
  const status = statusLabel(model, { stopping: false, observed, messages })
  // What it does now, once its stream says; the time on the right already says it works.
  const doing =
    state === "working" && model.live && model.live.parts.length > 0
      ? latestWorkLabel(model.live.parts, messages)
      : null

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${messages.delegation.open(title)}, ${status}`}
      data-child-row={child.key}
      data-child-state={state}
      className="group/row -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <AgentAvatar name={title} state={state} needsReader={needsReader} tint={tint} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {/* While it works, what it does now; otherwise what it was asked. */}
        {doing || task ? (
          <span
            className={cn(
              "block truncate text-xs text-muted-foreground",
              doing && "shimmer motion-reduce:animate-none"
            )}
          >
            {doing ?? task}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "max-w-[45%] shrink-0 truncate text-right text-xs tabular-nums",
          needsReader ? NEEDS_READER_TEXT : "text-muted-foreground"
        )}
      >
        {state === "working" || state === "done" ? <WorkedFor views={[view]} /> : status}
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover/row:text-muted-foreground"
        aria-hidden="true"
      />
    </button>
  )
}

/**
 * A sub-agent's thread, in the panel: how it stands, the model it runs on and how long it worked,
 * with a way to stop it while it works; then the task it was given, its work and what it made.
 */
export function ChildDetail({
  model,
  source,
  unavailable,
}: {
  readonly model: ChildModel
  readonly source: ChildrenSource
  readonly unavailable: boolean
}) {
  const messages = useAgentMessages()
  const labels = messages.delegation
  const cards = useDelegationCards()
  const { child, view, live, needsReader } = model
  const { runId, observed } = source
  const title = childTitle(child.key)
  const task = view?.task ?? child.task
  const run = activeRun(view)

  const stop = useStop(model, source)
  const canStop =
    run !== undefined && runId !== null && (cards?.actions?.canStop(run.parentRunId) ?? false)
  const status = statusLabel(model, { stopping: stop.stopping, observed, messages })
  const files = view ? returnedFiles(view) : []

  return (
    <section
      aria-label={labels.card(title)}
      data-child-detail={child.key}
      className="flex flex-col gap-5"
    >
      <div className="flex min-w-0 items-center gap-3 pt-1">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              "truncate font-medium",
              needsReader ? NEEDS_READER_TEXT : "text-foreground/80"
            )}
          >
            {status}
          </span>
          <span className="shrink-0 tabular-nums empty:hidden before:mr-1.5 before:content-['·']">
            <WorkedFor views={[view]} />
          </span>
        </p>
        <ModelChip child={child} view={view} className="shrink-0 text-xs opacity-80" />
        {canStop ? (
          <button
            type="button"
            onClick={stop.stop}
            disabled={stop.stopping}
            aria-label={labels.stopLabel(title)}
            className="h-7 shrink-0 rounded-full bg-muted px-3 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground hover:text-background focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
          >
            {labels.stop}
          </button>
        ) : null}
      </div>
      {stop.failed ? (
        <p role="alert" className="-mt-3 text-xs text-destructive">
          {labels.stopFailed}
        </p>
      ) : null}

      {/* What the agent asked of it, which opens its thread. */}
      {task ? (
        <div>
          <p className="mb-1.5 text-xs text-muted-foreground">{labels.task}</p>
          <p className="border-l-2 border-border pl-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground/85">
            {task}
          </p>
        </div>
      ) : null}

      <ChildWork
        view={view}
        live={live}
        source={source}
        unavailable={unavailable}
        waited={model.waited}
        enabled
      />

      {files.length > 0 && view ? (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">{labels.made}</p>
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
        </div>
      ) : null}
    </section>
  )
}

/**
 * What waits on the reader from one sub-agent, under the reply's line: the question it asked, and
 * the calls it holds for approval. Named when the reply has several, so each says whose it is.
 */
export function ChildAttention({
  model,
  observed,
  named,
}: {
  readonly model: ChildModel
  readonly observed: boolean
  readonly named: boolean
}) {
  const labels = useAgentMessages().delegation
  const cards = useDelegationCards()
  const { child, view, live, state, needsReader } = model
  const exchanges = cards?.delegation.exchanges.get(child.id) ?? []
  const openQuestion =
    view?.awaiting?.type === "answer"
      ? view.awaiting.question.text
      : state === "asking" && live
        ? liveQuestion(live.parts)
        : null
  const asks = exchanges.length > 0 || openQuestion !== null
  if (!asks && model.approvals.length === 0 && !model.heldLater) return null

  return (
    <div className="flex flex-col gap-2" data-child-key={child.key}>
      {asks ? (
        <div className="pl-[1.875rem]">
          {named ? (
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {childTitle(child.key)}
            </p>
          ) : null}
          <Exchanges
            exchanges={exchanges}
            openQuestion={openQuestion}
            urgent={needsReader || state === "asking"}
          />
          {state === "answer" && !observed ? (
            <p className="mt-1 text-xs text-muted-foreground">{labels.answerHint}</p>
          ) : null}
        </div>
      ) : null}
      {model.heldLater ? (
        <button
          type="button"
          onClick={() => revealApproval(model.heldLater?.id)}
          className="ml-[1.625rem] flex h-7 w-fit items-center gap-1 rounded-full px-2 text-xs font-medium text-amber-700 outline-none transition-colors hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-ring/40 dark:text-amber-400"
        >
          <ArrowDown className="size-3.5" aria-hidden="true" />
          {labels.viewRequest}
        </button>
      ) : null}
      {model.approvals.map((approval) => (
        <ApprovalCard key={approval.id} held={heldCallOf(approval)} underCaller={!named} />
      ))}
    </div>
  )
}

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
