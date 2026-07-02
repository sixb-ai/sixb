import type { ListAuthSessionsResponse } from "@sixb/client"
import {
  listAuthSessionsOptions,
  listAuthSessionsQueryKey,
  revokeAuthSessionMutation,
  signOutAllMutation,
} from "@sixb/client/hooks"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  EmptyState,
  toast,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertCircle, Loader2, LogOut, MonitorSmartphone } from "lucide-react"
import { useState } from "react"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"
import { apiErrorMessage, LoadingSpinner } from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

type AuthSession = ListAuthSessionsResponse["sessions"][number]

// Best-effort, human-readable label from a raw user-agent string. The stored
// value is untrusted and only used for display.
//
// Distinct from the shared `describeClient`: that one identifies token clients
// (CLIs, curl, CI) first and returns `undefined` for anything it can't place,
// whereas auth sessions are always browsers, so this always yields a concrete
// label and falls back to "Browser"/"Unknown OS" rather than nothing.
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
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const sessionsQuery = useQuery({
    ...listAuthSessionsOptions(),
    retry: false,
  })
  const sessions = sessionsQuery.data?.sessions ?? []

  const refreshSessions = () =>
    queryClient.invalidateQueries({ queryKey: listAuthSessionsQueryKey() })

  const revokeSession = useMutation({
    ...revokeAuthSessionMutation(),
    onSuccess: async () => {
      toast.success("Device signed out.")
      await refreshSessions()
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not sign out that device."))
    },
  })

  const signOutEverywhere = useMutation({
    ...signOutAllMutation(),
    onSuccess: () => {
      // The current session is revoked too, so return the user to sign-in.
      window.location.reload()
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not sign out everywhere."))
    },
  })

  const revoke = (sessionId: string) => {
    setRevokingId(sessionId)
    revokeSession.mutate({ path: { sessionId } }, { onSettled: () => setRevokingId(null) })
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <SettingsTabs />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Sessions</h1>
          <p className="mt-1.5 max-w-[52ch] text-sm text-muted-foreground">
            Browsers and devices signed in to your account.
          </p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={signOutEverywhere.isPending}
              className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              {signOutEverywhere.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LogOut className="h-4 w-4" />
              )}
              Sign out everywhere
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
              <AlertDialogDescription>
                Ends every active session for your account, on all devices and apps — including this
                one. You'll need to sign in again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => signOutEverywhere.mutate({})}
              >
                Sign out everywhere
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-baseline justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Active sessions</h2>
          <span className="text-xs text-muted-foreground">{sessions.length} active</span>
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
