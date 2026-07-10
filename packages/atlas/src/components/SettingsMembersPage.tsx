import type {
  GetAuthInvitationOptionsResponse,
  ListAuthInvitationsResponse,
  ListAuthMembersResponse,
} from "@sixb/client"
import {
  createAuthInvitationMutation,
  getAuthInvitationOptionsOptions,
  getAuthInvitationOptionsQueryKey,
  getAuthMembershipOptionsOptions,
  getAuthMembershipOptionsQueryKey,
  getAuthSessionOptions,
  getAuthSessionQueryKey,
  listAuthInvitationsOptions,
  listAuthInvitationsQueryKey,
  listAuthMembersOptions,
  listAuthMembersQueryKey,
  reactivateAuthMemberMutation,
  revokeAuthInvitationMutation,
  suspendAuthMemberMutation,
  updateAuthMemberGroupsMutation,
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
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  toast,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Ban,
  CheckCircle2,
  Clock3,
  Loader2,
  Mail,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RotateCcw,
  Search,
  UsersRound,
  XCircle,
} from "lucide-react"
import { type SubmitEvent, useEffect, useMemo, useState } from "react"
import { formatRelativeTime } from "../lib/time"
import {
  AccessErrorState,
  type AuthGroupOption,
  apiErrorMessage,
  formatDate,
  GroupPicker,
  LoadingSpinner,
  ScopeChips,
} from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

type Member = ListAuthMembersResponse["members"][number]
type MemberUser = Member["user"]
type MemberStatus = MemberUser["status"]
type StatusFilter = "all" | MemberStatus
type Invitation = ListAuthInvitationsResponse["invitations"][number]
type InvitationCreateCapability =
  GetAuthInvitationOptionsResponse["capabilities"]["createInvitation"]
type InvitationDestination = GetAuthInvitationOptionsResponse["destinations"][number]
type MemberAction = "suspend" | "reactivate"

const memberListOptions = {
  query: {
    order: "asc" as const,
    limit: "100",
  },
}

const invitationListOptions = {
  query: {
    order: "desc" as const,
    limit: "100",
  },
}

const STATUS_FILTERS: readonly { readonly id: StatusFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "suspended", label: "Suspended" },
]

function displayName(user: MemberUser): string {
  return user.displayName?.trim() || user.email
}

function initials(user: MemberUser): string {
  const source = user.displayName?.trim() || user.email.split("@")[0] || user.id
  const words = source.split(/[\s._-]+/).filter(Boolean)
  if (words.length === 0) return "?"
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase()
}

function MemberAvatar({
  user,
  size = "sm",
}: {
  readonly user: MemberUser
  readonly size?: "sm" | "lg"
}) {
  return user.avatarUrl ? (
    <img
      src={user.avatarUrl}
      alt=""
      className={cn(
        "shrink-0 rounded-full border border-border/60 object-cover",
        size === "lg" ? "h-12 w-12" : "h-9 w-9"
      )}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full bg-accent font-semibold uppercase tracking-tight text-accent-foreground",
        size === "lg" ? "h-12 w-12 text-base" : "h-9 w-9 text-xs"
      )}
    >
      {initials(user)}
    </span>
  )
}

function MemberStatusBadge({ status }: { readonly status: MemberStatus }) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        Active
      </Badge>
    )
  }

  return (
    <Badge
      variant="outline"
      className="rounded-full border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    >
      Suspended
    </Badge>
  )
}

function isInvitationExpired(invitation: Invitation): boolean {
  return invitation.status === "pending" && new Date(invitation.expiresAt).getTime() <= Date.now()
}

function InvitationStatusBadge({ invitation }: { readonly invitation: Invitation }) {
  if (isInvitationExpired(invitation)) {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      >
        <Clock3 className="h-3 w-3" />
        Expired
      </Badge>
    )
  }
  if (invitation.status === "pending") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
      >
        <Clock3 className="h-3 w-3" />
        Pending
      </Badge>
    )
  }
  if (invitation.status === "accepted") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        <CheckCircle2 className="h-3 w-3" />
        Accepted
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="rounded-full border-border/60 bg-muted text-muted-foreground"
    >
      <XCircle className="h-3 w-3" />
      Revoked
    </Badge>
  )
}

function capabilityMessage(
  member: Member,
  action: "assignGroups" | "suspend" | "reactivate",
  currentUserId: string | null
): string | null {
  if (member.capabilities[action]) return null

  if (action === "assignGroups") {
    return "Your membership policy lets you see this member, but not change their groups."
  }

  if (action === "suspend") {
    if (member.user.id === currentUserId) return "You cannot suspend yourself."
    return "Your membership policy does not allow suspending this member."
  }

  return "Your membership policy does not allow reactivating this member."
}

function inviteDisabledMessage(capability: InvitationCreateCapability | undefined): string | null {
  if (!capability) return "Invitations unavailable."
  if (capability.state === "enabled") return null
  if (capability.reason === "invitation_delivery_not_supported") {
    return "Invitation delivery is not supported by the active auth strategy."
  }
  return "Your account cannot create invitations."
}

function InviteMembersCard({
  groups,
  destinations,
  destinationId,
  canInviteWithoutGroups,
  disabledReason,
  email,
  onEmailChange,
  onDestinationChange,
  selectedGroupIds,
  onGroupsChange,
  onSubmit,
  isSubmitting,
  errorMessage,
}: {
  readonly groups: readonly AuthGroupOption[]
  readonly destinations: readonly InvitationDestination[]
  readonly destinationId: string
  readonly canInviteWithoutGroups: boolean
  readonly disabledReason: string | null
  readonly email: string
  readonly onEmailChange: (email: string) => void
  readonly onDestinationChange: (destinationId: string) => void
  readonly selectedGroupIds: readonly string[]
  readonly onGroupsChange: (groupIds: string[]) => void
  readonly onSubmit: (body: {
    email: string
    groupIds: string[]
    destinationId?: "atlas" | "app"
  }) => void
  readonly isSubmitting: boolean
  readonly errorMessage: string | null
}) {
  const disabled = disabledReason !== null
  const canSubmit =
    !disabled &&
    email.trim().length > 0 &&
    (destinations.length === 0 || destinationId.length > 0) &&
    (selectedGroupIds.length > 0 || canInviteWithoutGroups) &&
    !isSubmitting

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit({
      email: email.trim(),
      groupIds: [...selectedGroupIds],
      ...(destinationId === "atlas" || destinationId === "app" ? { destinationId } : {}),
    })
  }

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <form onSubmit={submit}>
        <div className="p-5 sm:p-6">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Invite members</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Send an invitation and choose where the member lands and what they can access.
          </p>

          {disabled ? (
            <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
              {disabledReason}
            </p>
          ) : null}

          <div
            className={cn(
              "mt-5 grid gap-4",
              destinations.length > 0
                ? "sm:grid-cols-[minmax(0,1fr)_minmax(13rem,0.42fr)]"
                : "sm:grid-cols-1"
            )}
          >
            <div className="space-y-1.5">
              <label htmlFor="invite-email" className="block text-sm font-medium text-foreground">
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                value={email}
                autoComplete="off"
                onChange={(event) => onEmailChange(event.target.value)}
                disabled={disabled || isSubmitting}
                placeholder="ava@acme.com"
                className="h-10 w-full rounded-lg border border-border/60 bg-background px-3.5 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>

            {destinations.length > 0 ? (
              <div className="space-y-1.5">
                <label
                  htmlFor="invite-destination"
                  className="block text-sm font-medium text-foreground"
                >
                  Destination
                </label>
                <Select
                  value={destinationId || undefined}
                  onValueChange={onDestinationChange}
                  disabled={disabled || isSubmitting}
                >
                  <SelectTrigger
                    id="invite-destination"
                    className="h-10 w-full rounded-lg border-border/60 bg-background px-3.5 shadow-none focus-visible:ring-ring/20 data-[size=default]:h-10 dark:bg-background dark:hover:bg-background"
                  >
                    <SelectValue placeholder="Choose an app" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((destination) => (
                      <SelectItem key={destination.id} value={destination.id}>
                        {destination.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <div className="mt-5 border-t border-border/60 pt-4">
            <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="text-sm font-medium text-foreground">Access groups</span>
              {groups.length > 0 && !canInviteWithoutGroups ? (
                <span className="text-xs text-muted-foreground">Select at least one group</span>
              ) : null}
            </div>
            <GroupPicker
              groups={groups}
              selectedGroupIds={selectedGroupIds}
              onChange={onGroupsChange}
              disabled={disabled || isSubmitting}
              emptyMessage="You have no groups available to assign."
            />
          </div>

          {errorMessage && (
            <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>

        <div className="flex justify-end border-t border-border/60 bg-muted/20 px-5 py-3 sm:px-6">
          <Button type="submit" disabled={!canSubmit} className="shrink-0">
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Send invite
          </Button>
        </div>
      </form>
    </section>
  )
}

function InvitationRow({
  invitation,
  groupOptionsById,
  revoking,
  onRevoke,
  showStatus = false,
}: {
  readonly invitation: Invitation
  readonly groupOptionsById: ReadonlyMap<string, AuthGroupOption>
  readonly revoking: boolean
  readonly onRevoke?: (invitationId: string) => void
  // Rows inside "Pending invitations" skip the redundant Pending badge; the
  // past-invitations list needs the full status to tell rows apart.
  readonly showStatus?: boolean
}) {
  const revocable = invitation.status === "pending" && onRevoke !== undefined

  return (
    <li className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/30">
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground"
      >
        <Mail className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{invitation.email}</span>
          {showStatus || isInvitationExpired(invitation) ? (
            <InvitationStatusBadge invitation={invitation} />
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>Invited {formatRelativeTime(invitation.createdAt)}</span>
          {invitation.status === "pending" ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span>
                {isInvitationExpired(invitation) ? "Expired" : "Expires"}{" "}
                {formatDate(invitation.expiresAt)}
              </span>
            </>
          ) : null}
          <span className="md:hidden">
            <ScopeChips
              groupIds={invitation.groupIds}
              groupOptionsById={groupOptionsById}
              emptyLabel="No groups"
            />
          </span>
        </span>
      </span>
      <span className="hidden max-w-[40%] shrink-0 justify-end md:flex">
        <ScopeChips
          groupIds={invitation.groupIds}
          groupOptionsById={groupOptionsById}
          emptyLabel="No groups"
        />
      </span>
      {revocable ? (
        <button
          type="button"
          onClick={() => onRevoke(invitation.id)}
          disabled={revoking}
          className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-border/60 px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
        >
          {revoking ? "Revoking…" : "Revoke"}
        </button>
      ) : null}
    </li>
  )
}

export function SettingsMembersPage() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null)
  const [draftGroupIds, setDraftGroupIds] = useState<string[]>([])
  const [pendingAction, setPendingAction] = useState<{
    readonly type: MemberAction
    readonly memberId: string
  } | null>(null)
  const [activeTab, setActiveTab] = useState<"members" | "invitations">("members")
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteDestinationId, setInviteDestinationId] = useState("")
  const [inviteGroupIds, setInviteGroupIds] = useState<string[]>([])
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null)
  const [showPastInvitations, setShowPastInvitations] = useState(false)

  const sessionQuery = useQuery({ ...getAuthSessionOptions(), retry: false })
  const optionsQuery = useQuery({ ...getAuthMembershipOptionsOptions(), retry: false })
  const membersQuery = useQuery({
    ...listAuthMembersOptions(memberListOptions),
    enabled: optionsQuery.isSuccess,
    retry: false,
  })
  const inviteOptionsQuery = useQuery({ ...getAuthInvitationOptionsOptions(), retry: false })
  const invitationsQuery = useQuery({
    ...listAuthInvitationsOptions(invitationListOptions),
    enabled: inviteOptionsQuery.isSuccess,
    retry: false,
  })

  const groupOptions = optionsQuery.data?.groups ?? []
  const members = membersQuery.data?.members ?? []
  const currentUserId = sessionQuery.data?.authenticated ? sessionQuery.data.user.id : null
  const groupOptionsById = useMemo(
    () => new Map<string, AuthGroupOption>(groupOptions.map((group) => [group.id, group])),
    [groupOptions]
  )

  const inviteOptions = inviteOptionsQuery.data
  const inviteDestinations = inviteOptions?.destinations ?? []
  const resolvedInviteDestinationId = inviteDestinations.some(
    (destination) => destination.id === inviteDestinationId
  )
    ? inviteDestinationId
    : (inviteOptions?.defaultDestinationId ?? inviteDestinations[0]?.id ?? "")
  const inviteGroupOptions = useMemo<readonly AuthGroupOption[]>(
    () => inviteOptions?.groups ?? [],
    [inviteOptions]
  )
  const inviteGroupOptionsById = useMemo(
    () => new Map<string, AuthGroupOption>(inviteGroupOptions.map((group) => [group.id, group])),
    [inviteGroupOptions]
  )
  const inviteDisabledReason = inviteOptionsQuery.isLoading
    ? null
    : inviteDisabledMessage(inviteOptions?.capabilities.createInvitation)
  const invitations = invitationsQuery.data?.invitations ?? []
  const pendingInvitations = useMemo(
    () => invitations.filter((invitation) => invitation.status === "pending"),
    [invitations]
  )
  const pastInvitations = useMemo(
    () => invitations.filter((invitation) => invitation.status !== "pending"),
    [invitations]
  )

  const visibleMembers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return members.filter((member) => {
      if (statusFilter !== "all" && member.user.status !== statusFilter) return false
      if (!needle) return true
      return (
        member.user.email.toLowerCase().includes(needle) ||
        member.user.displayName?.toLowerCase().includes(needle) === true ||
        member.user.id.toLowerCase().includes(needle)
      )
    })
  }, [members, query, statusFilter])

  const selectedMember = useMemo(
    () => members.find((member) => member.user.id === selectedMemberId) ?? null,
    [members, selectedMemberId]
  )
  const editingMember = useMemo(
    () => members.find((member) => member.user.id === editingMemberId) ?? null,
    [members, editingMemberId]
  )
  const pendingActionMember = useMemo(
    () => members.find((member) => member.user.id === pendingAction?.memberId) ?? null,
    [members, pendingAction]
  )

  useEffect(() => {
    if (!selectedMemberId || selectedMember || membersQuery.isFetching) return
    setSelectedMemberId(null)
  }, [membersQuery.isFetching, selectedMember, selectedMemberId])

  // If the invitable groups shrink (policy change, refetch), drop any selected
  // group the user can no longer assign so a submit never sends a stale id.
  useEffect(() => {
    if (!inviteOptions) return
    const allowed = new Set(inviteOptions.groups.map((group) => group.id))
    setInviteGroupIds((previous) => previous.filter((groupId) => allowed.has(groupId)))
  }, [inviteOptions])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthMembershipOptionsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listAuthMembersQueryKey(memberListOptions) }),
      queryClient.invalidateQueries({ queryKey: getAuthSessionQueryKey() }),
    ])
  }

  const refreshInvitations = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthInvitationOptionsQueryKey() }),
      queryClient.invalidateQueries({
        queryKey: listAuthInvitationsQueryKey(invitationListOptions),
      }),
    ])
  }

  const updateGroups = useMutation({
    ...updateAuthMemberGroupsMutation(),
    onSuccess: async (result) => {
      toast.success(`Updated groups for ${displayName(result.member.user)}.`)
      setEditingMemberId(null)
      await refresh()
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not update member groups."))
    },
  })

  const suspendMember = useMutation({
    ...suspendAuthMemberMutation(),
    onSuccess: async (result) => {
      toast.success(`${displayName(result.member.user)} suspended.`)
      await refresh()
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not suspend the member."))
    },
  })

  const reactivateMember = useMutation({
    ...reactivateAuthMemberMutation(),
    onSuccess: async (result) => {
      toast.success(`${displayName(result.member.user)} reactivated.`)
      await refresh()
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not reactivate the member."))
    },
  })

  const createInvitation = useMutation({
    ...createAuthInvitationMutation(),
    onSuccess: async (result) => {
      toast.success(
        result.delivery.status === "sent"
          ? `Invitation sent to ${result.invitation.email}.`
          : `Invitation created for ${result.invitation.email}.`
      )
      setInviteEmail("")
      setInviteGroupIds([])
      // Land on the invitations tab so the new invite is visible immediately.
      setActiveTab("invitations")
      await refreshInvitations()
    },
  })

  const revokeInvitation = useMutation({
    ...revokeAuthInvitationMutation(),
    onSuccess: async () => {
      toast.success("Invitation revoked.")
      await refreshInvitations()
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not revoke the invitation."))
    },
  })

  const openMember = (memberId: string) => {
    setSelectedMemberId(memberId)
  }

  const closeSheet = () => {
    setSelectedMemberId(null)
    setEditingMemberId(null)
  }

  const openEditGroups = (member: Member) => {
    updateGroups.reset()
    setDraftGroupIds([...member.groupIds])
    setEditingMemberId(member.user.id)
  }

  const submitGroups = () => {
    if (!editingMember || !editingMember.capabilities.assignGroups || updateGroups.isPending) return
    updateGroups.mutate({
      path: { userId: editingMember.user.id },
      body: { groupIds: draftGroupIds },
    })
  }

  const requestMemberAction = (type: MemberAction, memberId: string) => {
    setPendingAction({ type, memberId })
  }

  const confirmMemberAction = () => {
    if (!pendingAction || !pendingActionMember) return
    if (pendingAction.type === "suspend") {
      suspendMember.mutate({ path: { userId: pendingActionMember.user.id } })
    } else {
      reactivateMember.mutate({ path: { userId: pendingActionMember.user.id } })
    }
    setPendingAction(null)
  }

  const revokeInvite = (invitationId: string) => {
    setRevokingInvitationId(invitationId)
    revokeInvitation.mutate(
      { path: { invitationId } },
      { onSettled: () => setRevokingInvitationId(null) }
    )
  }

  if (optionsQuery.isLoading) {
    return (
      <div className="flex min-h-90 items-center justify-center">
        <LoadingSpinner text="Loading member settings…" />
      </div>
    )
  }

  if (optionsQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <SettingsTabs />
        <AccessErrorState
          title="Member settings unavailable"
          description={apiErrorMessage(optionsQuery.error, "Could not load member settings.")}
        />
      </div>
    )
  }

  // Why the sheet's Edit/Suspend buttons are disabled, if they are.
  const groupsNote = selectedMember
    ? capabilityMessage(selectedMember, "assignGroups", currentUserId)
    : null
  const accessNote = selectedMember
    ? capabilityMessage(
        selectedMember,
        selectedMember.user.status === "active" ? "suspend" : "reactivate",
        currentUserId
      )
    : null

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <SettingsTabs />

      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Members</h1>
        <p className="mt-1.5 max-w-[56ch] text-sm text-muted-foreground">
          Manage workspace members and invitations.
        </p>
      </div>

      <InviteMembersCard
        groups={inviteGroupOptions}
        destinations={inviteDestinations}
        destinationId={resolvedInviteDestinationId}
        canInviteWithoutGroups={inviteOptions?.canInviteWithoutGroups === true}
        disabledReason={inviteDisabledReason}
        email={inviteEmail}
        onEmailChange={setInviteEmail}
        onDestinationChange={setInviteDestinationId}
        selectedGroupIds={inviteGroupIds}
        onGroupsChange={setInviteGroupIds}
        onSubmit={(body) =>
          createInvitation.mutate({
            body: {
              email: body.email,
              ...(body.groupIds.length > 0 ? { groupIds: body.groupIds } : {}),
              ...(body.destinationId ? { destinationId: body.destinationId } : {}),
            },
          })
        }
        isSubmitting={createInvitation.isPending}
        errorMessage={
          createInvitation.isError
            ? apiErrorMessage(createInvitation.error, "Could not create the invitation.")
            : null
        }
      />

      <div className="flex gap-5 border-b border-border/60">
        {(
          [
            { id: "members", label: "Members", count: membersQuery.data?.total ?? 0 },
            { id: "invitations", label: "Pending invitations", count: pendingInvitations.length },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            aria-pressed={activeTab === tab.id}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 pb-2.5 text-sm font-medium transition-colors",
              activeTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {activeTab === "members" && members.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search members"
              className="h-9 w-full rounded-lg border border-border/60 bg-card pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
            />
          </div>
          <div className="inline-flex h-9 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-card">
            {STATUS_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                aria-pressed={statusFilter === filter.id}
                onClick={() => setStatusFilter(filter.id)}
                className={cn(
                  "border-l border-border/60 px-3 text-xs font-medium transition-colors first:border-l-0",
                  statusFilter === filter.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === "members" && (
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {membersQuery.isLoading ? (
            <div className="flex min-h-50 items-center justify-center">
              <LoadingSpinner text="Loading members…" />
            </div>
          ) : membersQuery.isError ? (
            <AccessErrorState
              title="Members unavailable"
              description={apiErrorMessage(membersQuery.error, "Could not load members.")}
            />
          ) : visibleMembers.length === 0 ? (
            <EmptyState
              icon={<UsersRound className="h-9 w-9" />}
              title={members.length === 0 ? "No manageable members" : "No matching members"}
              description={
                members.length === 0
                  ? "You can only see users inside your membership-policy scope."
                  : "Try a different search or status filter."
              }
            />
          ) : (
            <ul className="divide-y divide-border/60">
              {visibleMembers.map((member) => {
                const active = member.user.status === "active"
                return (
                  <li
                    key={member.user.id}
                    className="group flex items-center gap-2 pr-3 transition-colors hover:bg-muted/30"
                  >
                    <button
                      type="button"
                      onClick={() => openMember(member.user.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left"
                    >
                      <MemberAvatar user={member.user} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {displayName(member.user)}
                          </span>
                          {member.user.status === "suspended" ? (
                            <MemberStatusBadge status={member.user.status} />
                          ) : null}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="truncate">
                            {displayName(member.user) === member.user.email
                              ? `Joined ${formatDate(member.user.createdAt)}`
                              : member.user.email}
                          </span>
                          <span className="md:hidden">
                            <ScopeChips
                              groupIds={member.groupIds}
                              groupOptionsById={groupOptionsById}
                              emptyLabel="No groups"
                            />
                          </span>
                        </span>
                      </span>
                    </button>
                    <span className="hidden max-w-[40%] shrink-0 justify-end md:flex">
                      <ScopeChips
                        groupIds={member.groupIds}
                        groupOptionsById={groupOptionsById}
                        emptyLabel="No groups"
                      />
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="shrink-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Actions for ${displayName(member.user)}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => openMember(member.user.id)}>
                          <PanelRight className="h-3.5 w-3.5" />
                          View details
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!member.capabilities.assignGroups}
                          onSelect={() => openEditGroups(member)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit groups
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {active ? (
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={!member.capabilities.suspend}
                            onSelect={() => requestMemberAction("suspend", member.user.id)}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            Suspend
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled={!member.capabilities.reactivate}
                            onSelect={() => requestMemberAction("reactivate", member.user.id)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reactivate
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {activeTab === "invitations" &&
        (invitationsQuery.isError ? (
          <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <AccessErrorState
              title="Invitations unavailable"
              description={apiErrorMessage(invitationsQuery.error, "Could not load invitations.")}
            />
          </section>
        ) : (
          <>
            <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              {invitationsQuery.isLoading ? (
                <div className="flex min-h-50 items-center justify-center">
                  <LoadingSpinner text="Loading invitations…" />
                </div>
              ) : pendingInvitations.length === 0 ? (
                <EmptyState
                  icon={<Mail className="h-9 w-9" />}
                  title="No pending invitations"
                  description="Invitations you send stay here until they're accepted."
                />
              ) : (
                <ul className="divide-y divide-border/60">
                  {pendingInvitations.map((invitation) => (
                    <InvitationRow
                      key={invitation.id}
                      invitation={invitation}
                      groupOptionsById={inviteGroupOptionsById}
                      revoking={revokingInvitationId === invitation.id}
                      onRevoke={revokeInvite}
                    />
                  ))}
                </ul>
              )}
            </section>

            {pastInvitations.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setShowPastInvitations((previous) => !previous)}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showPastInvitations
                    ? "Hide past invitations"
                    : `Show past invitations (${pastInvitations.length})`}
                </button>
                {showPastInvitations && (
                  <section className="mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                    <ul className="divide-y divide-border/60">
                      {pastInvitations.map((invitation) => (
                        <InvitationRow
                          key={invitation.id}
                          invitation={invitation}
                          groupOptionsById={inviteGroupOptionsById}
                          revoking={false}
                          showStatus
                        />
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </>
        ))}

      <Sheet open={selectedMember !== null} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-136">
          {selectedMember ? (
            <>
              <div className="border-b border-border/60 p-5 pr-12">
                <MemberStatusBadge status={selectedMember.user.status} />
                <div className="mt-3.5 flex items-start gap-3">
                  <MemberAvatar user={selectedMember.user} size="lg" />
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate text-lg">
                      {displayName(selectedMember.user)}
                    </SheetTitle>
                    <SheetDescription className="mt-0.5 truncate">
                      {selectedMember.user.email}
                    </SheetDescription>
                  </div>
                </div>
              </div>

              <div className="flex-1 space-y-5 overflow-auto p-5">
                <section className="rounded-xl border border-border/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">Groups</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Current group memberships for this user.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!selectedMember.capabilities.assignGroups}
                      onClick={() => openEditGroups(selectedMember)}
                      title={groupsNote ?? undefined}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                  </div>
                  <div className="mt-3">
                    <ScopeChips
                      groupIds={selectedMember.groupIds}
                      groupOptionsById={groupOptionsById}
                      emptyLabel="No groups"
                    />
                  </div>
                  {groupsNote ? (
                    <p className="mt-3 text-xs text-muted-foreground">{groupsNote}</p>
                  ) : null}
                </section>

                <section className="rounded-xl border border-border/60 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-foreground">Access</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {selectedMember.user.status === "active"
                          ? "Suspending blocks sign-in and revokes active sessions immediately."
                          : "Reactivating allows sign-in again; old sessions stay revoked."}
                      </p>
                    </div>
                    {selectedMember.user.status === "active" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!selectedMember.capabilities.suspend || suspendMember.isPending}
                        className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        title={accessNote ?? undefined}
                        onClick={() => requestMemberAction("suspend", selectedMember.user.id)}
                      >
                        {suspendMember.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                        Suspend
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={
                          !selectedMember.capabilities.reactivate || reactivateMember.isPending
                        }
                        title={accessNote ?? undefined}
                        onClick={() => requestMemberAction("reactivate", selectedMember.user.id)}
                      >
                        {reactivateMember.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Reactivate
                      </Button>
                    )}
                  </div>
                  {accessNote ? (
                    <p className="mt-3 text-xs text-muted-foreground">{accessNote}</p>
                  ) : null}
                </section>

                <section className="rounded-xl border border-border/60 p-4">
                  <h3 className="text-sm font-semibold text-foreground">Profile</h3>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Created
                      </dt>
                      <dd className="mt-1 text-sm text-foreground">
                        {formatDate(selectedMember.user.createdAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Updated
                      </dt>
                      <dd className="mt-1 text-sm text-foreground">
                        {formatDate(selectedMember.user.updatedAt)}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={pendingAction !== null && pendingActionMember !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
      >
        <AlertDialogContent>
          {pendingAction && pendingActionMember ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingAction.type === "suspend" ? "Suspend" : "Reactivate"}{" "}
                  {displayName(pendingActionMember.user)}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingAction.type === "suspend"
                    ? "This immediately revokes their active sessions. The user will not be able to sign in until reactivated."
                    : "This restores the user's active status. They will need to sign in again; previous sessions remain revoked."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={cn(
                    pendingAction.type === "suspend" &&
                      "bg-destructive text-white hover:bg-destructive/90"
                  )}
                  onClick={confirmMemberAction}
                >
                  {pendingAction.type === "suspend" ? "Suspend member" : "Reactivate member"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editingMember !== null}
        onOpenChange={(open) => {
          if (!open) setEditingMemberId(null)
        }}
      >
        <DialogContent>
          {editingMember ? (
            <>
              <DialogHeader>
                <DialogTitle>Edit groups</DialogTitle>
                <DialogDescription>
                  Replace groups for {displayName(editingMember.user)}. Leaving every group
                  unchecked makes the member group-less.
                </DialogDescription>
              </DialogHeader>

              <GroupPicker
                groups={groupOptions}
                selectedGroupIds={draftGroupIds}
                disabled={updateGroups.isPending}
                onChange={setDraftGroupIds}
                emptyMessage="You do not have any assignable groups. Saving with no selections keeps the member group-less."
              />

              {updateGroups.isError ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {apiErrorMessage(updateGroups.error, "Could not update member groups.")}
                </p>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingMemberId(null)}
                  disabled={updateGroups.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={submitGroups}
                  disabled={!editingMember.capabilities.assignGroups || updateGroups.isPending}
                >
                  {updateGroups.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save groups
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
