import { isSixbApiError } from "@sixb/client"
import {
  listAgentThreadInboxOptions,
  listAgentThreadInboxQueryKey,
  updateAgentThreadInboxItemMutation,
  withdrawAgentThreadInboxItemMutation,
} from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CornerDownRight, ListEnd, Send, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useCurrentUser } from "../../session"
import { useAgentMessages } from "../i18n"
import { TRAY_MESSAGE_ATTRIBUTE, trayMessageKey } from "../inbox-handoff"
import { samePrincipal, userPrincipal } from "../sharing"
import type { AgentInboxItem } from "../types"

export interface PendingMessagesProps {
  readonly threadId: string | null
  /**
   * The running turn is the reader's own, as the composer's `steerable` says. Another person's
   * turn takes no steer and no Send now from the reader: their messages wait for their own turn.
   */
  readonly steerable?: boolean
  /**
   * The messages the running turn read, by id: each leaves the tray as the conversation shows it
   * where the turn read it.
   */
  readonly read?: ReadonlySet<string>
  readonly className?: string
}

const NOTHING_READ: ReadonlySet<string> = new Set()

/** How long a line takes to fold away, or to open. */
const FOLD_MS = 320

/**
 * The messages waiting beside a running turn: steers it reads at its next step, and turns queued
 * behind it. Each can be promoted, sent now, or taken back, until a step reads it.
 */
export function PendingMessages({
  threadId,
  steerable = true,
  read = NOTHING_READ,
  className,
}: PendingMessagesProps) {
  const labels = useAgentMessages().composer
  const me = userPrincipal(useCurrentUser())
  const queryClient = useQueryClient()
  // Why the last change did not go through, until the next one is asked for.
  const [failure, setFailure] = useState<string | null>(null)
  const inbox = useQuery({
    ...listAgentThreadInboxOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
    // The turn's stream says when a step reads a steer. While anything waits the tray reads again
    // all the same: a message a turn took, or one that started a turn, leaves it.
    refetchInterval: (query) => ((query.state.data?.items.length ?? 0) > 0 ? 5_000 : false),
  })
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: listAgentThreadInboxQueryKey({ path: { threadId: threadId ?? "" } }),
    })

  // Read again either way. A message a turn already read has left the tray for the conversation,
  // which needs no word; any other refusal says why nothing changed.
  const failed = (message: string) => (error: unknown) => {
    if (isSixbApiError(error) && error.code === "invalid_state") return
    setFailure(
      isSixbApiError(error) && error.code === "not_run_requester" ? labels.notYourAnswer : message
    )
  }
  const promote = useMutation({
    ...updateAgentThreadInboxItemMutation(),
    onMutate: () => setFailure(null),
    onError: failed(labels.changeFailed),
    onSettled: refresh,
  })
  const withdraw = useMutation({
    ...withdrawAgentThreadInboxItemMutation(),
    onMutate: () => setFailure(null),
    onError: failed(labels.withdrawFailed),
    onSettled: refresh,
  })

  // A line the turn read folds away as its message takes its place in the conversation, from the
  // copy the tray last held: the list read again no longer has it.
  const held = useRef(new Map<string, AgentInboxItem>())
  const [folded, setFolded] = useState<ReadonlySet<string>>(NOTHING_READ)
  const fetched = threadId === null ? [] : (inbox.data?.items ?? [])
  for (const item of fetched) held.current.set(item.messageId, item)
  const leaving = [...read].flatMap((messageId) => {
    const item = held.current.get(messageId)
    return item && !folded.has(messageId) && item.threadId === threadId ? [item] : []
  })
  const items = [...fetched.filter((item) => !read.has(item.messageId)), ...leaving].sort(
    (a, b) => a.seq - b.seq
  )
  const open = useOpened(items.length > 0)
  if (items.length === 0) return null

  const fold = (messageId: string) => {
    held.current.delete(messageId)
    setFolded((current) => new Set(current).add(messageId))
  }

  return (
    // The composer's own column: the tray lines up with the input it waits above. It opens and
    // closes by its height, so the conversation above moves with it instead of jumping.
    <div
      className={cn(
        "grid transition-[grid-template-rows] ease-out motion-reduce:transition-none",
        open && leaving.length < items.length ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
      )}
      style={{ transitionDuration: `${FOLD_MS}ms` }}
      data-pending-messages=""
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn("px-4", className)}>
          <div className="mx-auto flex w-full max-w-[46rem] flex-col rounded-2xl bg-muted/60 p-1">
            {items.map((item) => (
              <PendingMessage
                key={item.id}
                item={item}
                leaving={read.has(item.messageId)}
                onLeft={() => fold(item.messageId)}
                mine={samePrincipal(item.authorPrincipal, me)}
                steerable={steerable}
                labels={labels}
                busy={promote.isPending || withdraw.isPending}
                onSteer={() =>
                  threadId !== null &&
                  promote.mutate({
                    path: { threadId, itemId: item.id },
                    body: { delivery: "steer" },
                  })
                }
                onSendNow={() =>
                  threadId !== null &&
                  promote.mutate({ path: { threadId, itemId: item.id }, body: { immediate: true } })
                }
                onWithdraw={() =>
                  threadId !== null && withdraw.mutate({ path: { threadId, itemId: item.id } })
                }
              />
            ))}
            {failure ? (
              <p role="alert" className="px-3 pt-1 pb-1.5 text-[13px] text-destructive">
                {failure}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/** False on the first frame `shown` is true, then true: what opens by a transition starts closed. */
function useOpened(shown: boolean): boolean {
  const [opened, setOpened] = useState(false)
  useEffect(() => {
    if (!shown) {
      setOpened(false)
      return
    }
    const frame = requestAnimationFrame(() => setOpened(true))
    return () => cancelAnimationFrame(frame)
  }, [shown])
  return shown && opened
}

function PendingMessage({
  item,
  leaving,
  onLeft,
  mine,
  steerable: turnSteerable,
  labels,
  busy,
  onSteer,
  onSendNow,
  onWithdraw,
}: {
  readonly item: AgentInboxItem
  /** The turn read it: the line folds away, and its message rises into the conversation. */
  readonly leaving: boolean
  readonly onLeft: () => void
  /** Only the person who sent it may change it: another participant's shows without actions. */
  readonly mine: boolean
  readonly steerable: boolean
  readonly labels: ReturnType<typeof useAgentMessages>["composer"]
  readonly busy: boolean
  readonly onSteer: () => void
  readonly onSendNow: () => void
  readonly onWithdraw: () => void
}) {
  const text = item.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim()
  // A steer is read mid-turn, which prepares no file: one that carries a file stays queued.
  const steerable =
    turnSteerable &&
    item.mode === "queue" &&
    item.immediate !== true &&
    !item.parts.some((part) => part.type === "file")
  const status =
    item.immediate === true
      ? labels.sendNowPending
      : item.mode === "steer"
        ? labels.steerPending
        : labels.queuePending
  const Status = item.immediate === true ? Send : item.mode === "steer" ? CornerDownRight : ListEnd
  const opened = useOpened(true)

  // The chat draws again with every chunk of the answer: the fold's end is not put off by it.
  const left = useRef(onLeft)
  left.current = onLeft
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => left.current(), FOLD_MS)
    return () => clearTimeout(timer)
  }, [leaving])

  return (
    // A line opens as it arrives and folds away once read, while its message rises into place.
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] ease-out motion-reduce:transition-none",
        opened && !leaving ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        leaving && "opacity-0"
      )}
      // Its words leave at once, for the conversation's copy; the space they held closes after.
      style={{ transitionDuration: `${FOLD_MS}ms, ${leaving ? 120 : FOLD_MS}ms` }}
      aria-hidden={leaving || undefined}
    >
      <div className="min-h-0 overflow-hidden">
        {/* One quiet line: where it goes, what it says, and, on hover, what can still be done with it. */}
        <div
          title={status}
          className="group flex h-9 items-center gap-2.5 rounded-xl pr-1 pl-3 text-[14px] tracking-[-0.006em] transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <Status aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">{status}: </span>
          <p
            className="min-w-0 flex-1 truncate text-foreground/75"
            {...{ [TRAY_MESSAGE_ATTRIBUTE]: trayMessageKey(item.messageId) }}
          >
            {text || labels.waitingFile}
          </p>
          {mine ? (
            <div className="flex shrink-0 items-center transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
              {steerable ? (
                <button
                  type="button"
                  onClick={onSteer}
                  disabled={busy}
                  title={labels.steer}
                  aria-label={labels.steer}
                  className={ACTION_CLASS}
                >
                  <CornerDownRight className="size-3.5" />
                </button>
              ) : null}
              {/* Sending now stops the answer in flight: only whoever asked for it may. */}
              {turnSteerable ? (
                <button
                  type="button"
                  onClick={onSendNow}
                  disabled={busy}
                  title={labels.sendNow}
                  aria-label={labels.sendNow}
                  className={ACTION_CLASS}
                >
                  <Send className="size-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                onClick={onWithdraw}
                disabled={busy}
                title={labels.withdraw}
                aria-label={labels.withdraw}
                className={ACTION_CLASS}
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const ACTION_CLASS = cn(
  "flex size-7 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors",
  "hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
  "dark:hover:bg-white/[0.08]"
)
