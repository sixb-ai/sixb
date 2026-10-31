import {
  getSyncOptions,
  getSyncQueryKey,
  listSyncRunsQueryKey,
  listSyncsQueryKey,
  requestSyncRunMutation,
} from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { apiErrorMessage, useFormat } from "../../section-ui"
import { useSyncLiveUpdates } from "./live-updates"
import { useDataMessages } from "./messages"

export interface SyncButtonProps {
  /** The sync's id, as named in `syncs/`. */
  readonly sync: string
  /** Shows when it last synced, or that it failed, beside the button. A refused request shows either way. */
  readonly showStatus?: boolean
  readonly variant?: "default" | "outline" | "secondary" | "ghost"
  readonly size?: "default" | "sm"
  readonly className?: string
}

/**
 * Starts a sync and shows it working until its run ends, for any page that shows synced data.
 * People without the `run` grant on the sync see the request refused beside the button.
 */
export function SyncButton({
  sync,
  showStatus = false,
  variant = "outline",
  size = "sm",
  className,
}: SyncButtonProps) {
  const messages = useDataMessages().syncButton
  const format = useFormat()
  const queryClient = useQueryClient()
  const path = { syncId: sync }
  useSyncLiveUpdates({ syncId: sync })

  const syncQuery = useQuery({
    ...getSyncOptions({ path }),
    retry: false,
    // Live updates refresh it as the run moves; polling covers a dropped event stream.
    refetchInterval: (query) => {
      const status = query.state.data?.latestRun?.status
      return status === "queued" || status === "running" ? 5000 : false
    },
  })
  const request = useMutation({
    ...requestSyncRunMutation(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: getSyncQueryKey({ path }) }),
        queryClient.invalidateQueries({ queryKey: listSyncsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listSyncRunsQueryKey() }),
      ]),
  })

  const latestRun = syncQuery.data?.latestRun ?? null
  const working =
    request.isPending || latestRun?.status === "queued" || latestRun?.status === "running"

  let status: { readonly text: string; readonly failed: boolean } | null = null
  if (request.isError) {
    status = { text: apiErrorMessage(request.error, messages.requestFailed), failed: true }
  } else if (!working && syncQuery.isSuccess) {
    if (!latestRun) status = { text: messages.never, failed: false }
    else if (latestRun.status === "failed") status = { text: messages.failed, failed: true }
    else if (latestRun.status === "succeeded")
      status = {
        text: messages.synced(format.relative(latestRun.finishedAt ?? latestRun.queuedAt)),
        failed: false,
      }
  }

  return (
    <div className={cn("inline-flex items-center gap-3", className)}>
      {status && (showStatus || request.isError) ? (
        <span
          className={cn(
            "text-[0.8125rem]",
            status.failed ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
          )}
        >
          {status.text}
        </span>
      ) : null}
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={working}
        onClick={() => request.mutate({ path, body: {} })}
      >
        <RefreshCw className={cn(working && "animate-spin")} />
        {working ? messages.syncing : messages.syncNow}
      </Button>
    </div>
  )
}
