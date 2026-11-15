import {
  listAgentThreadInboxOptions,
  listAgentThreadInboxQueryKey,
  updateAgentThreadInboxItemMutation,
  withdrawAgentThreadInboxItemMutation,
} from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUp, Send, X } from "lucide-react"
import { useAgentMessages } from "../i18n"
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
  const queryClient = useQueryClient()
  const inbox = useQuery({
    ...listAgentThreadInboxOptions({ path: { threadId: threadId ?? "" } }),
    enabled: threadId !== null,
  })
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: listAgentThreadInboxQueryKey({ path: { threadId: threadId ?? "" } }),
    })

  const promote = useMutation({
    ...updateAgentThreadInboxItemMutation(),
    onSuccess: refresh,
  })
  const withdraw = useMutation({
    ...withdrawAgentThreadInboxItemMutation(),
    onSuccess: refresh,
  })

  const items = threadId === null ? [] : (inbox.data?.items ?? [])
  if (items.length === 0) return null

  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-pending-messages="">
      {items.map((item) => (
        <PendingMessage
          key={item.id}
          item={item}
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
  )
}

function PendingMessage({
  item,
  labels,
  busy,
  onSteer,
  onSendNow,
  onWithdraw,
}: {
  readonly item: AgentInboxItem
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
  const queued = item.mode === "queue" && item.immediate !== true

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
      <div className="flex shrink-0 items-center gap-1">
        {queued ? (
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
    </div>
  )
}

const ACTION_CLASS = cn(
  "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
  "hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
  "dark:hover:bg-white/[0.08]"
)
