import {
  listAgentThreadInboxOptions,
  listAgentThreadInboxQueryKey,
  updateAgentThreadInboxItemMutation,
  withdrawAgentThreadInboxItemMutation,
} from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUp, Send, X } from "lucide-react"
import { useCurrentUser } from "../../session"
import { useAgentMessages } from "../i18n"
import { samePrincipal, userPrincipal } from "../sharing"
import type { AgentInboxItem } from "../types"

/**
 * The messages waiting beside a running turn: steers it reads at its next step, and turns queued
 * behind it. Each can be promoted, sent now, or taken back, until a step reads it.
 */
export function PendingMessages({
  threadId,
  className,
}: {
  readonly threadId: string | null
  readonly className?: string
}) {
  const labels = useAgentMessages().composer
  const me = userPrincipal(useCurrentUser())
  const queryClient = useQueryClient()
  const inbox = useQuery({
    ...listAgentThreadInboxOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
    // No event says a step read a steer, so while anything waits the tray reads again: a message a
    // turn took leaves it.
    refetchInterval: (query) => ((query.state.data?.items.length ?? 0) > 0 ? 5_000 : false),
  })
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: listAgentThreadInboxQueryKey({ path: { threadId: threadId ?? "" } }),
    })

  // Settled either way: a refusal most often means a turn read the message first.
  const promote = useMutation({
    ...updateAgentThreadInboxItemMutation(),
    onSettled: refresh,
  })
  const withdraw = useMutation({
    ...withdrawAgentThreadInboxItemMutation(),
    onSettled: refresh,
  })

  const items = threadId === null ? [] : (inbox.data?.items ?? [])
  if (items.length === 0) return null

  return (
    // The composer's own column: the tray lines up with the input it waits above.
    <div className={cn("px-4", className)} data-pending-messages="">
      <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-1.5">
        {items.map((item) => (
          <PendingMessage
            key={item.id}
            item={item}
            mine={samePrincipal(item.authorPrincipal, me)}
            labels={labels}
            busy={promote.isPending || withdraw.isPending}
            onSteer={() =>
              threadId !== null &&
              promote.mutate({ path: { threadId, itemId: item.id }, body: { delivery: "steer" } })
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
      </div>
    </div>
  )
}

function PendingMessage({
  item,
  mine,
  labels,
  busy,
  onSteer,
  onSendNow,
  onWithdraw,
}: {
  readonly item: AgentInboxItem
  /** Only the person who sent it may change it: another participant's shows without actions. */
  readonly mine: boolean
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
    item.mode === "queue" &&
    item.immediate !== true &&
    !item.parts.some((part) => part.type === "file")

  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 break-words text-foreground/80">{text || labels.waitingFile}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {item.immediate === true
            ? labels.sendNowPending
            : item.mode === "steer"
              ? labels.steerPending
              : labels.queuePending}
        </p>
      </div>
      {mine ? (
        <div className="flex shrink-0 items-center gap-1">
          {steerable ? (
            <button
              type="button"
              onClick={onSteer}
              disabled={busy}
              title={labels.steer}
              aria-label={labels.steer}
              className={ACTION_CLASS}
            >
              <ArrowUp className="size-3.5" />
            </button>
          ) : null}
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
  )
}

const ACTION_CLASS = cn(
  "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
  "hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
  "dark:hover:bg-white/[0.08]"
)
