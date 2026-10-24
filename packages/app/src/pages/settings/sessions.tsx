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
  Button,
} from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Monitor, MonitorSmartphone, Smartphone, SquareTerminal } from "lucide-react"
import { useState } from "react"
import { notify } from "../section-page"
import {
  apiErrorMessage,
  IconTile,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  useFormat,
} from "../section-ui"
import { type DeviceKind, useDescribeDevice } from "./controls"
import { useSettingsMessages } from "./messages"

const deviceIcons: Record<DeviceKind, typeof Monitor> = {
  desktop: Monitor,
  phone: Smartphone,
  terminal: SquareTerminal,
}

/** The browsers, apps and CLI signed in as you, on Settings › Personal. */
export function SessionsSection() {
  const allMessages = useSettingsMessages()
  const messages = allMessages.sessions
  const queryClient = useQueryClient()
  const format = useFormat()
  const describeDevice = useDescribeDevice()
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const sessionsQuery = useQuery({ ...listAuthSessionsOptions(), retry: false })
  // This device first, then the most recently used.
  const sessions = [...(sessionsQuery.data?.sessions ?? [])].sort(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      (right.lastSeenAt ?? right.createdAt).localeCompare(left.lastSeenAt ?? left.createdAt)
  )

  const revokeSession = useMutation({
    ...revokeAuthSessionMutation(),
    onSuccess: async () => {
      notify.success(messages.signedOut)
      await queryClient.invalidateQueries({ queryKey: listAuthSessionsQueryKey() })
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.signOutFailed)),
  })

  const signOutEverywhere = useMutation({
    ...signOutAllMutation(),
    // This session ends too, so reloading sends the browser to sign in.
    onSuccess: () => window.location.reload(),
    onError: (error) => notify.error(apiErrorMessage(error, messages.signOutEverywhereFailed)),
  })

  return (
    <PageSection
      title={messages.title}
      description={messages.description}
      action={
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={signOutEverywhere.isPending || sessions.length === 0}
            >
              {signOutEverywhere.isPending ? <Loader2 className="animate-spin" /> : null}
              {messages.signOutEverywhere}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{messages.confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>{messages.confirmDescription}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{allMessages.common.cancel}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => signOutEverywhere.mutate({})}>
                {messages.signOutEverywhere}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    >
      <Panel>
        {sessionsQuery.isPending ? (
          <PanelSkeleton rows={2} />
        ) : sessionsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={MonitorSmartphone}
            title={messages.unavailable}
            description={apiErrorMessage(sessionsQuery.error, messages.loadFailed)}
          />
        ) : sessions.length === 0 ? (
          <PanelEmpty
            icon={MonitorSmartphone}
            title={messages.emptyTitle}
            description={messages.emptyDescription}
          />
        ) : (
          sessions.map((session) => {
            const device = describeDevice(session)
            return (
              <PanelRow
                key={session.id}
                leading={<IconTile icon={deviceIcons[device.kind]} />}
                title={
                  <>
                    <span className="truncate">{device.label}</span>
                    {session.current ? <Pill tone="ok">{messages.thisDevice}</Pill> : null}
                  </>
                }
                meta={
                  <>
                    {session.ipAddress ? (
                      <>
                        <span className="tabular-nums">{session.ipAddress}</span>
                        <MetaDot />
                      </>
                    ) : null}
                    <span>
                      {session.current
                        ? messages.activeNow
                        : messages.active(format.relative(session.lastSeenAt ?? session.createdAt))}
                    </span>
                  </>
                }
                trailing={
                  session.current ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={revokingId === session.id}
                      onClick={() => {
                        setRevokingId(session.id)
                        revokeSession.mutate(
                          { path: { sessionId: session.id } },
                          { onSettled: () => setRevokingId(null) }
                        )
                      }}
                    >
                      {revokingId === session.id ? messages.signingOut : messages.signOut}
                    </Button>
                  )
                }
              />
            )
          })
        )}
      </Panel>
    </PageSection>
  )
}
