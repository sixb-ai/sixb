import type { GetAuthInvitationOptionsResponse, ListAuthInvitationsResponse } from "@pario/client"
import {
  createAuthInvitationMutation,
  getAuthInvitationOptionsOptions,
  getAuthInvitationOptionsQueryKey,
  listAuthInvitationsOptions,
  listAuthInvitationsQueryKey,
  revokeAuthInvitationMutation,
} from "@pario/client/hooks"
import { Badge, EmptyState } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Loader2,
  Mail,
  RefreshCw,
  Shield,
  UserPlus,
  XCircle,
} from "lucide-react"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import { humanizeIdentifier } from "../lib/labels"
import { formatRelativeTime } from "../lib/time"

type Invitation = ListAuthInvitationsResponse["invitations"][number]
type InvitationGroupOption = GetAuthInvitationOptionsResponse["groups"][number]

const invitationListOptions = {
  query: {
    order: "desc" as const,
    limit: "100",
  },
}

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

function groupLabel(group: InvitationGroupOption): string {
  return group.label ?? humanizeIdentifier(group.id)
}

function statusClasses(status: Invitation["status"], expired: boolean): string {
  if (expired) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
  }

  if (status === "pending") {
    return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
  }

  if (status === "accepted") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
  }

  return "border-muted-foreground/20 bg-muted text-muted-foreground"
}

function StatusBadge({ invitation }: { invitation: Invitation }) {
  const expired = isExpired(invitation)
  const label = expired ? "Expired" : humanizeIdentifier(invitation.status)
  const Icon =
    invitation.status === "accepted"
      ? CheckCircle2
      : invitation.status === "revoked"
        ? XCircle
        : Clock3

  return (
    <Badge
      variant="outline"
      className={cn("rounded-md", statusClasses(invitation.status, expired))}
    >
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  )
}

function isExpired(invitation: Invitation): boolean {
  return invitation.status === "pending" && new Date(invitation.expiresAt).getTime() <= Date.now()
}

function formatDateTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function createDisabledMessage(
  capability: GetAuthInvitationOptionsResponse["capabilities"]["createInvitation"]
): string {
  if (capability.state === "enabled") return ""
  if (capability.reason === "invitation_delivery_not_supported") {
    return "Invitation delivery is not supported by the active auth strategy."
  }
  return "Your account cannot create invitations."
}

export function SettingsInvitationsPage() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null)

  const invitationOptionsQuery = useQuery(getAuthInvitationOptionsOptions())
  const invitationsQuery = useQuery({
    ...listAuthInvitationsOptions(invitationListOptions),
    enabled: invitationOptionsQuery.isSuccess,
  })

  const options = invitationOptionsQuery.data
  const invitations = invitationsQuery.data?.invitations ?? []
  const groupOptions = options?.groups ?? []
  const createCapability = options?.capabilities.createInvitation
  const canCreateInvitation = createCapability?.state === "enabled"
  const createDisabledReason = createCapability ? createDisabledMessage(createCapability) : ""
  const canSubmit =
    canCreateInvitation &&
    email.trim().length > 0 &&
    (selectedGroupIds.length > 0 || options?.canInviteWithoutGroups === true)

  const groupOptionsById = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group])),
    [groupOptions]
  )

  const refreshInvitationQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthInvitationOptionsQueryKey() }),
      queryClient.invalidateQueries({
        queryKey: listAuthInvitationsQueryKey(invitationListOptions),
      }),
    ])
  }

  const createInvitation = useMutation({
    ...createAuthInvitationMutation(),
    onSuccess: async (result) => {
      setEmail("")
      setSelectedGroupIds([])
      setFormError(null)
      setMessage(
        result.delivery.status === "sent"
          ? `Invitation sent to ${result.invitation.email}.`
          : `Invitation created for ${result.invitation.email}.`
      )
      await refreshInvitationQueries()
    },
    onError: (error) => {
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not create the invitation."))
    },
  })

  const revokeInvitation = useMutation({
    ...revokeAuthInvitationMutation(),
    onSuccess: async () => {
      setMessage("Invitation revoked.")
      await refreshInvitationQueries()
    },
    onError: (error) => {
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not revoke the invitation."))
    },
  })

  useEffect(() => {
    if (!options) return
    const allowedGroupIds = new Set(options.groups.map((group) => group.id))
    setSelectedGroupIds((previous) => previous.filter((groupId) => allowedGroupIds.has(groupId)))
  }, [options])

  const toggleGroup = (groupId: string) => {
    setMessage(null)
    setFormError(null)
    setSelectedGroupIds((previous) =>
      previous.includes(groupId)
        ? previous.filter((selectedGroupId) => selectedGroupId !== groupId)
        : [...previous, groupId]
    )
  }

  const submitInvitation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(null)
    setFormError(null)

    if (!canSubmit || createInvitation.isPending) {
      return
    }

    createInvitation.mutate({
      body: {
        email: email.trim(),
        ...(selectedGroupIds.length > 0 ? { groupIds: selectedGroupIds } : {}),
      },
    })
  }

  const revoke = (invitationId: string) => {
    setMessage(null)
    setFormError(null)
    setRevokingInvitationId(invitationId)
    revokeInvitation.mutate(
      { path: { invitationId } },
      {
        onSettled: () => setRevokingInvitationId(null),
      }
    )
  }

  if (invitationOptionsQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <LoadingSpinner text="Loading invitation settings..." />
      </div>
    )
  }

  if (invitationOptionsQuery.isError) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <EmptyState
          icon={<AlertCircle className="h-10 w-10" />}
          title="Invitation settings unavailable"
          description={apiErrorMessage(invitationOptionsQuery.error, "Could not load invitations.")}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">
            Invitations
          </h1>
        </div>
        <button
          type="button"
          onClick={() => {
            invitationsQuery.refetch()
            invitationOptionsQuery.refetch()
          }}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <section className="rounded-xl border border-border/60 bg-card">
        <form onSubmit={submitInvitation} className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <UserPlus className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">Create invitation</h2>
            </div>
          </div>

          {createDisabledReason && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              {createDisabledReason}
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <label className="min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Email</span>
              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background px-3">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value)
                    setMessage(null)
                    setFormError(null)
                  }}
                  disabled={!canCreateInvitation || createInvitation.isPending}
                  placeholder="ava@acme.com"
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
                />
              </div>
            </label>

            <button
              type="submit"
              disabled={!canSubmit || createInvitation.isPending}
              className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createInvitation.isPending ? (
                <LoadingSpinner size="sm" className="text-primary-foreground" />
              ) : (
                <UserPlus className="h-4 w-4" />
              )}
              Send invitation
            </button>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Groups</p>
            <div className="flex flex-wrap gap-2">
              {options?.canInviteWithoutGroups && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedGroupIds([])
                    setMessage(null)
                    setFormError(null)
                  }}
                  disabled={!canCreateInvitation}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    selectedGroupIds.length === 0
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border/60 bg-background text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                  )}
                >
                  <Shield className="h-4 w-4" />
                  No groups
                </button>
              )}

              {groupOptions.map((group) => {
                const selected = selectedGroupIds.includes(group.id)
                return (
                  <button
                    type="button"
                    key={group.id}
                    onClick={() => toggleGroup(group.id)}
                    disabled={!canCreateInvitation}
                    className={cn(
                      "inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                      selected
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border/60 bg-background text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    )}
                  >
                    <Shield className="h-4 w-4 shrink-0" />
                    <span className="truncate">{groupLabel(group)}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {(message || formError) && (
            <p
              className={cn(
                "rounded-lg px-3 py-2 text-sm",
                formError
                  ? "border border-destructive/30 bg-destructive/10 text-destructive"
                  : "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              )}
            >
              {formError ?? message}
            </p>
          )}
        </form>
      </section>

      <section className="rounded-xl border border-border/60 bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Invitation history</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {invitationsQuery.data?.total ?? 0} visible
            </p>
          </div>
        </div>

        {invitationsQuery.isLoading ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <LoadingSpinner text="Loading invitations..." />
          </div>
        ) : invitationsQuery.isError ? (
          <EmptyState
            icon={<AlertCircle className="h-10 w-10" />}
            title="Invitations unavailable"
            description={apiErrorMessage(invitationsQuery.error, "Could not load invitations.")}
          />
        ) : invitations.length === 0 ? (
          <EmptyState
            icon={<Mail className="h-10 w-10" />}
            title="No visible invitations"
            description="Invitations covered by your policy scope will appear here."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-muted text-xs text-muted-foreground">
                  <th className="py-2 pl-4 pr-3 font-medium">User</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Groups</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="hidden px-3 py-2 font-medium lg:table-cell">Expires</th>
                  <th className="py-2 pl-3 pr-4 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((invitation, index) => (
                  <tr
                    key={invitation.id}
                    className={cn(
                      "transition-colors hover:bg-muted/30",
                      index !== invitations.length - 1 && "border-b border-border/40"
                    )}
                  >
                    <td className="py-3 pl-4 pr-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">{invitation.email}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Created {formatRelativeTime(invitation.createdAt)}
                        </p>
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 md:table-cell">
                      <div className="flex max-w-md flex-wrap gap-1.5">
                        {invitation.groupIds.length === 0 ? (
                          <Badge variant="secondary" className="rounded-md bg-muted text-xs">
                            No groups
                          </Badge>
                        ) : (
                          invitation.groupIds.map((groupId) => (
                            <Badge
                              key={groupId}
                              variant="secondary"
                              className="rounded-md bg-accent/70 text-xs"
                            >
                              {groupLabel(groupOptionsById.get(groupId) ?? { id: groupId })}
                            </Badge>
                          ))
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge invitation={invitation} />
                    </td>
                    <td className="hidden px-3 py-3 text-xs text-muted-foreground lg:table-cell">
                      {formatDateTime(invitation.expiresAt)}
                    </td>
                    <td className="py-3 pl-3 pr-4 text-right">
                      {invitation.status === "pending" ? (
                        <button
                          type="button"
                          onClick={() => revoke(invitation.id)}
                          disabled={revokingInvitationId === invitation.id}
                          className="inline-flex h-8 items-center justify-center rounded-lg border border-border/60 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {revokingInvitationId === invitation.id ? "Revoking" : "Revoke"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
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
