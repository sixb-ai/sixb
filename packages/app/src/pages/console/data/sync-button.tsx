import type { GetSyncResponse } from "@sixb/client"
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

type Sync = GetSyncResponse
type SyncStatus = { readonly text: string; readonly failed: boolean }

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
    refetchInterval: (query) => (query.state.data && isSyncing(query.state.data) ? 5000 : false),
  })
  const request = useMutation({
    ...requestSyncRunMutation(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: getSyncQueryKey({ path }) }),
        queryClient.invalidateQueries({ queryKey: listSyncsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listSyncRunsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: [{ _id: "listConnectorAccounts" }] }),
      ]),
  })

  const working = request.isPending || (syncQuery.data ? isSyncing(syncQuery.data) : false)

  let status: SyncStatus | null = null
  if (request.isError) {
    status = { text: apiErrorMessage(request.error, messages.requestFailed), failed: true }
  } else if (!working && syncQuery.data) {
    status = syncStatus(syncQuery.data, messages, format)
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

/** Whether a run is under way: the latest one, or on a sync of an OAuth connector, any account's. */
function isSyncing(sync: Sync): boolean {
  if (sync.accounts) return sync.accounts.running > 0

  const status = sync.latestRun?.status
  return status === "queued" || status === "running"
}

/**
 * When it last synced, or that it failed. On a sync of an OAuth connector, the accounts you see
 * tell: the latest run is only the account that ran last.
 */
function syncStatus(
  sync: Sync,
  messages: ReturnType<typeof useDataMessages>["syncButton"],
  format: ReturnType<typeof useFormat>
): SyncStatus | null {
  const accounts = sync.accounts

  if (accounts) {
    if (accounts.needsReconnecting > 0) {
      return { text: messages.accountsNeedReconnecting(accounts.needsReconnecting), failed: true }
    }
    if (accounts.failing > 0) {
      return { text: messages.accountsFailed(accounts.failing), failed: true }
    }
    if (accounts.lastSyncedAt) {
      return { text: messages.synced(format.relative(accounts.lastSyncedAt)), failed: false }
    }

    return { text: accounts.total === 0 ? messages.noAccounts : messages.never, failed: false }
  }

  const latestRun = sync.latestRun
  if (!latestRun) return { text: messages.never, failed: false }
  if (latestRun.status === "failed") return { text: messages.failed, failed: true }
  if (latestRun.status === "succeeded") {
    return {
      text: messages.synced(format.relative(latestRun.finishedAt ?? latestRun.queuedAt)),
      failed: false,
    }
  }

  return null
}
