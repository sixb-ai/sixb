import type { ListAuthSessionsResponse } from "@sixb/client"
import {
  listAuthSessionsOptions,
  listAuthSessionsQueryKey,
  revokeAuthSessionMutation,
  signOutAllMutation,
} from "@sixb/client/hooks"
import { Badge, EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Loader2, LogOut, MonitorSmartphone, RefreshCw } from "lucide-react"
import { useState } from "react"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { SettingsTabs } from "./SettingsTabs"

type AuthSession = ListAuthSessionsResponse["sessions"][number]

function LoadingSpinner({
  className,
  size = "md",
  text,
}: {
  readonly className?: string
  readonly size?: "sm" | "md"
  readonly text?: string
}) {
  const spinner = (
    <Loader2 className={cn(size === "sm" ? "h-4 w-4" : "h-5 w-5", "animate-spin", className)} />
  )

  if (!text) {
    return spinner
  }

  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      {spinner}
      <span className="text-sm">{text}</span>
    </div>
  )
}

function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    if ("error" in error && typeof error.error === "string") return error.error
    if ("message" in error && typeof error.message === "string") return error.message
  }
  return fallback
}

// Best-effort, human-readable label from a raw user-agent string. The stored
// value is untrusted and only used for display.
function describeDevice(userAgent?: string): string {
  if (!userAgent) return "Unknown device"
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\/|Opera/.test(userAgent)
      ? "Opera"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser"
  const os = /iPhone|iPad|iPod/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Macintosh|Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "Unknown OS"
  return `${browser} on ${os}`
}

export function SettingsSessionsPage() {
  const queryClient = useQueryClient()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const sessionsQuery = useQuery(listAuthSessionsOptions())
  const sessions = sessionsQuery.data?.sessions ?? []

  const refreshSessions = () =>
    queryClient.invalidateQueries({ queryKey: listAuthSessionsQueryKey() })

  const revokeSession = useMutation({
    ...revokeAuthSessionMutation(),
    onSuccess: async () => {
      setError(null)
      setMessage("Device signed out.")
      await refreshSessions()
    },
    onError: (mutationError) => {
      setMessage(null)
      setError(apiErrorMessage(mutationError, "Could not sign out that device."))
    },
  })

  const signOutEverywhere = useMutation({
    ...signOutAllMutation(),
    onSuccess: () => {
      // The current session is revoked too, so return the user to sign-in.
      window.location.reload()
    },
    onError: (mutationError) => {
      setMessage(null)
      setError(apiErrorMessage(mutationError, "Could not sign out everywhere."))
    },
  })

  const revoke = (sessionId: string) => {
    setMessage(null)
    setError(null)
    setRevokingId(sessionId)
    revokeSession.mutate({ path: { sessionId } }, { onSettled: () => setRevokingId(null) })
  }

  return (
    <div className="space-y-4">
      <SettingsTabs />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">Sessions</h1>
        </div>
        <button
          type="button"
          onClick={() => sessionsQuery.refetch()}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <section className="rounded-xl border border-border/60 bg-card">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <LogOut className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">Sign out everywhere</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Ends every active session for your account, on all devices and apps. You'll need to
                sign in again.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => signOutEverywhere.mutate({})}
            disabled={signOutEverywhere.isPending}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-destructive/30 bg-destructive/10 px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
          >
            {signOutEverywhere.isPending ? (
              <LoadingSpinner size="sm" />
            ) : (
              <LogOut className="h-4 w-4" />
            )}
            Sign out everywhere
          </button>
        </div>

        {(message || error) && (
          <p
            className={cn(
              "mx-4 mb-4 rounded-lg px-3 py-2 text-sm",
              error
                ? "border border-destructive/30 bg-destructive/10 text-destructive"
                : "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            )}
          >
            {error ?? message}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border/60 bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Active sessions</h2>
            <p className="mt-1 text-xs text-muted-foreground">{sessions.length} active</p>
          </div>
        </div>

        {sessionsQuery.isLoading ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <LoadingSpinner text="Loading sessions..." />
          </div>
        ) : sessionsQuery.isError ? (
          <EmptyState
            icon={<AlertCircle className="h-10 w-10" />}
            title="Sessions unavailable"
            description={apiErrorMessage(sessionsQuery.error, "Could not load active sessions.")}
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={<MonitorSmartphone className="h-10 w-10" />}
            title="No active sessions"
            description="Sessions you sign in with will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-muted text-xs text-muted-foreground">
                  <th className="py-2 pl-4 pr-3 font-medium">Device</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">IP address</th>
                  <th className="px-3 py-2 font-medium">Last active</th>
                  <th className="py-2 pl-3 pr-4 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session: AuthSession, index) => (
                  <tr
                    key={session.id}
                    className={cn(
                      "transition-colors hover:bg-muted/30",
                      index !== sessions.length - 1 && "border-b border-border/40"
                    )}
                  >
                    <td className="py-3 pl-4 pr-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {describeDevice(session.userAgent)}
                        </span>
                        <Badge variant="secondary" className="rounded-md bg-accent/70 text-xs">
                          {humanizeIdentifier(session.audience)}
                        </Badge>
                        {session.current && (
                          <Badge
                            variant="outline"
                            className="rounded-md border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-700 dark:text-emerald-300"
                          >
                            This device
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 text-xs text-muted-foreground md:table-cell">
                      {session.ipAddress ?? "Unknown"}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {formatRelativeTime(session.lastSeenAt ?? session.createdAt)}
                    </td>
                    <td className="py-3 pl-3 pr-4 text-right">
                      {session.current ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => revoke(session.id)}
                          disabled={revokingId === session.id}
                          className="inline-flex h-8 items-center justify-center rounded-lg border border-border/60 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {revokingId === session.id ? "Signing out" : "Sign out"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
