import { Spinner } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Fragment, memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { childFileSource, messageFileSource } from "../../artifacts/file-source"
import { FileAttachmentCard } from "../components/file-attachment-card"
import { AssistantBody } from "../components/message-parts"
import { useAgentMessages } from "../i18n"
import type { LiveRunState } from "../live-run"
import { normalizeDurableParts } from "../parts"
import type { AgentMessage } from "../types"
import type { AgentChild, WaitedChild } from "./interpret"
import { type ChildrenSource, useChildMessages } from "./use-children"

/**
 * What the child did: the files it was handed, then each run's work, the one at work live. A run
 * that continued another follows it under a line that says why.
 */
export function ChildWork({
  view,
  live,
  source,
  unavailable,
  waited,
  enabled,
}: {
  readonly view?: AgentChild
  /** Its run at work, as its stream shows it. */
  readonly live?: LiveRunState
  readonly source: ChildrenSource
  readonly unavailable: boolean
  readonly waited?: WaitedChild
  /** The panel is open: only then is its thread read. */
  readonly enabled: boolean
}) {
  const labels = useAgentMessages().delegation
  const { observed } = source
  const ended = (view?.runs ?? []).filter(
    (run) => run.status !== "queued" && run.status !== "running"
  )
  const messages = useChildMessages({
    threadId: view?.threadId ?? "",
    observed,
    enabled: enabled && view !== undefined && ended.length > 0,
  })

  // Its thread holds each run's work once the run ended. Read it again when a run ends that it
  // was read without, as an observer hears of nothing else.
  const byRun = useMemo(() => {
    const runs = new Map<string, AgentMessage[]>()
    for (const message of messages.data?.messages ?? []) {
      if (message.runId === null) continue
      runs.set(message.runId, [...(runs.get(message.runId) ?? []), message])
    }
    return runs
  }, [messages.data])
  const endedKey = ended.map((run) => `${run.id}:${run.status}`).join(",")
  const readFor = useRef<string | null>(null)
  const { refetch, isSuccess } = messages
  useEffect(() => {
    if (!enabled || !isSuccess) return
    if (readFor.current === null) {
      readFor.current = endedKey
      return
    }
    if (readFor.current === endedKey) return
    readFor.current = endedKey
    void refetch()
  }, [enabled, isSuccess, endedKey, refetch])

  if (unavailable || !view) {
    return (
      <div className="flex flex-col gap-2 text-[13px]">
        {unavailable ? <p className="text-muted-foreground">{labels.elsewhere}</p> : null}
        {waited?.text ? (
          <AssistantBody parts={[{ kind: "text", text: waited.text }]} nested />
        ) : null}
      </div>
    )
  }

  const [first] = view.runs
  return (
    <div className="flex flex-col gap-4">
      {view.handedFiles.length > 0 && first ? (
        <div>
          <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {labels.given}
          </p>
          <div className="flex flex-wrap gap-2">
            {view.handedFiles.map((file, index) => (
              <FileAttachmentCard
                key={file.path}
                fileRef={file.fileRef}
                className="w-[15rem] max-w-full"
                source={childFileSource({
                  threadId: view.threadId,
                  runId: first.id,
                  path: `/handedFiles/${index}/fileRef`,
                  fileRef: file.fileRef,
                  observed,
                })}
              />
            ))}
          </div>
        </div>
      ) : null}

      {view.runs.map((run, index) => {
        const atWork = run.status === "queued" || run.status === "running"
        const own = byRun.get(run.id) ?? []
        const work = own.filter((message) => message.role === "assistant")

        let body: ReactNode
        if (work.length > 0) {
          body = <RunWork messages={work} threadId={view.threadId} observed={observed} />
        } else if (atWork && live?.runId === run.id && live.parts.length > 0) {
          body = <AssistantBody parts={live.parts} live={live.active} nested />
        } else if (atWork) {
          // An observer reads no stream: a run's steps come once it ended.
          body = (
            <p className="text-[13px] text-muted-foreground shimmer motion-reduce:animate-none">
              {observed
                ? labels.stepsLater
                : run.status === "queued"
                  ? labels.states.starting
                  : labels.states.working}
            </p>
          )
        } else if (messages.isError) {
          body = <p className="text-[13px] text-muted-foreground">{labels.loadFailed}</p>
        } else if (messages.isLoading || messages.isFetching) {
          body = (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              {labels.loadingWork}
            </p>
          )
        } else {
          body = <p className="text-[13px] text-muted-foreground">{labels.noWork}</p>
        }

        return (
          <Fragment key={run.id}>
            {index > 0 ? (
              <p className="flex items-center gap-3 text-[11px] font-medium text-muted-foreground">
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
                {continuedAfterAnswer(own, view.runs[index - 1])
                  ? labels.continued.answer
                  : labels.continued.approval}
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
              </p>
            ) : null}
            <div className="flex flex-col gap-3">{body}</div>
          </Fragment>
        )
      })}
    </div>
  )
}

/**
 * Whether a run continued after its parent's answer rather than a decision: its trigger, the
 * thread's message that started it, holds the answer. Before the thread is read, the run before it
 * says what it paused on.
 */
function continuedAfterAnswer(
  messages: readonly AgentMessage[],
  previous: AgentChild["runs"][number] | undefined
): boolean {
  const trigger = messages.find((message) => message.role === "user")
  if (trigger) return trigger.parts.some((part) => part.type === "mail" && part.kind === "answer")
  return previous?.finishReason === "awaiting_answer"
}

/** One run's work, as its thread keeps it: its assistant messages, read once each. */
const RunWork = memo(function RunWork({
  messages,
  threadId,
  observed,
}: {
  readonly messages: readonly AgentMessage[]
  /** The child's thread, whose messages hold the files a tool showed it. */
  readonly threadId: string
  readonly observed: boolean
}) {
  const bodies = useMemo(
    () =>
      messages.map((message) =>
        normalizeDurableParts(message.parts, {
          fileSource: (fileRef, path) =>
            messageFileSource({ threadId, messageId: message.id, path, fileRef, observed }),
        })
      ),
    [messages, threadId, observed]
  )

  return (
    <>
      {bodies.map((parts, position) => (
        <AssistantBody key={messages[position]?.id ?? position} parts={parts} nested />
      ))}
    </>
  )
})

/**
 * A scrolling box that follows new content while its reader is at its end, and stays where they
 * scrolled otherwise.
 */
export function FollowingScroll({
  follow,
  live,
  className,
  children,
}: {
  /** Changes when the content grows. */
  readonly follow: string
  /** The content is still growing: it opens at its end. Otherwise at its start. */
  readonly live: boolean
  readonly className?: string
  readonly children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const atEnd = useRef(live)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `follow` is the trigger
  useLayoutEffect(() => {
    const element = box.current
    if (element && atEnd.current) element.scrollTop = element.scrollHeight
  }, [follow])

  return (
    <div
      ref={box}
      onScroll={(event) => {
        const element = event.currentTarget
        atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
      }}
      className={cn("scrollbar-thin overflow-y-auto overscroll-contain", className)}
    >
      {children}
    </div>
  )
}
