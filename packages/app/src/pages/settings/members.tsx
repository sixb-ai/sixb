import type {
  CreateAuthInvitationResponse,
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
  Button,
  Checkbox,
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Ban,
  Loader2,
  Mail,
  MoreHorizontal,
  PanelRight,
  Pencil,
  RotateCcw,
  Search,
  UserPlus,
  UsersRound,
} from "lucide-react"
import { type ReactNode, type SubmitEvent, useEffect, useMemo, useState } from "react"
import { useCurrentUser } from "../../session"
import { notify, SectionPage } from "../section-page"
import {
  type AuthGroupOption,
  apiErrorMessage,
  CopyField,
  Field,
  FormError,
  GroupChips,
  GroupPicker,
  IconTile,
  MetaDot,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  PersonAvatar,
  Pill,
  ToolbarTabs,
  useFormat,
  Warning,
} from "./controls"
import { type SettingsMessages, useSettingsMessages } from "./messages"

type Member = ListAuthMembersResponse["members"][number]
type MemberUser = Member["user"]
type Invitation = ListAuthInvitationsResponse["invitations"][number]
type InvitationOptions = GetAuthInvitationOptionsResponse
type RevealedLink = NonNullable<CreateAuthInvitationResponse["delivery"]["link"]> & {
  readonly email: string
}
type MemberAction = "suspend" | "reactivate"

const memberListOptions = { query: { order: "asc" as const, limit: "100" } }
const invitationListOptions = { query: { order: "desc" as const, limit: "100" } }

function displayName(user: MemberUser): string {
  return user.displayName?.trim() || user.email
}

function isExpired(invitation: Invitation): boolean {
  return invitation.status === "pending" && new Date(invitation.expiresAt).getTime() <= Date.now()
}

function inviteDisabledReason(
  options: InvitationOptions | undefined,
  messages: SettingsMessages["members"]["invite"]
): string | null {
  const capability = options?.capabilities.createInvitation
  if (!capability) return messages.unavailable
  if (capability.state === "enabled") return null
  if (capability.reason === "invitation_delivery_not_supported") return messages.deliveryUnsupported
  return messages.notAllowed
}

/** Settings › Members: the people who can sign in, their groups, and invitations. */
export function SettingsMembersPage() {
  const allMessages = useSettingsMessages()
  const messages = allMessages.members
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const format = useFormat()
  const [query, setQuery] = useState("")
  const [activeTab, setActiveTab] = useState<"members" | "invitations">("members")
  const [inviteOpen, setInviteOpen] = useState(false)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null)
  const [draftGroupIds, setDraftGroupIds] = useState<string[]>([])
  const [pendingAction, setPendingAction] = useState<{
    readonly type: MemberAction
    readonly memberId: string
  } | null>(null)
  const [revealedLink, setRevealedLink] = useState<RevealedLink | null>(null)
  const [revokingInvitationId, setRevokingInvitationId] = useState<string | null>(null)
  const [showPastInvitations, setShowPastInvitations] = useState(false)

  const optionsQuery = useQuery({ ...getAuthMembershipOptionsOptions(), retry: false })
  const membersQuery = useQuery({ ...listAuthMembersOptions(memberListOptions), retry: false })
  const inviteOptionsQuery = useQuery({ ...getAuthInvitationOptionsOptions(), retry: false })
  const invitationsQuery = useQuery({
    ...listAuthInvitationsOptions(invitationListOptions),
    retry: false,
  })

  const assignableGroups = optionsQuery.data?.groups
  const members = membersQuery.data?.members ?? []
  const groupsById = useMemo(() => {
    // Members can hold groups the caller cannot assign; invitation options often know their labels.
    const all = [...(inviteOptionsQuery.data?.groups ?? []), ...(assignableGroups ?? [])]
    return new Map<string, AuthGroupOption>(all.map((group) => [group.id, group]))
  }, [assignableGroups, inviteOptionsQuery.data])
  const inviteOptions = inviteOptionsQuery.data
  const invitations = invitationsQuery.data?.invitations ?? []
  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending")
  const pastInvitations = invitations.filter((invitation) => invitation.status !== "pending")
  const disabledReason = inviteOptionsQuery.isPending
    ? null
    : inviteDisabledReason(inviteOptions, messages.invite)

  const visibleMembers = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return members
    return members.filter(
      (member) =>
        member.user.email.toLowerCase().includes(needle) ||
        member.user.displayName?.toLowerCase().includes(needle) === true
    )
  }, [members, query])

  const findMember = (id: string | null | undefined) =>
    members.find((member) => member.user.id === id) ?? null
  const selectedMember = findMember(selectedMemberId)
  const editingMember = findMember(editingMemberId)
  const actionMember = findMember(pendingAction?.memberId)

  // A member who disappears after a refetch closes their sheet instead of leaving it empty.
  useEffect(() => {
    if (selectedMemberId && !selectedMember && !membersQuery.isFetching) setSelectedMemberId(null)
  }, [membersQuery.isFetching, selectedMember, selectedMemberId])

  const refreshMembers = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthMembershipOptionsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listAuthMembersQueryKey(memberListOptions) }),
      // Changing your own groups changes what you may open.
      queryClient.invalidateQueries({ queryKey: getAuthSessionQueryKey() }),
    ])

  const refreshInvitations = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthInvitationOptionsQueryKey() }),
      queryClient.invalidateQueries({
        queryKey: listAuthInvitationsQueryKey(invitationListOptions),
      }),
    ])

  const updateGroups = useMutation({
    ...updateAuthMemberGroupsMutation(),
    onSuccess: async (result) => {
      notify.success(messages.edit.updated(displayName(result.member.user)))
      setEditingMemberId(null)
      await refreshMembers()
    },
  })

  const suspendMember = useMutation({
    ...suspendAuthMemberMutation(),
    onSuccess: async (result) => {
      notify.success(messages.confirm.suspended(displayName(result.member.user)))
      await refreshMembers()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.confirm.suspendFailed)),
  })

  const reactivateMember = useMutation({
    ...reactivateAuthMemberMutation(),
    onSuccess: async (result) => {
      notify.success(messages.confirm.reactivated(displayName(result.member.user)))
      await refreshMembers()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.confirm.reactivateFailed)),
  })

  const createInvitation = useMutation({
    ...createAuthInvitationMutation(),
    onSuccess: async (result) => {
      setInviteOpen(false)
      if (result.delivery.link) {
        setRevealedLink({ ...result.delivery.link, email: result.invitation.email })
      }
      notify.success(
        result.delivery.status === "sent"
          ? messages.invite.sent(result.invitation.email)
          : messages.invite.created(result.invitation.email)
      )
      // Show the new invitation where it now lives.
      setActiveTab("invitations")
      await refreshInvitations()
    },
  })

  const revokeInvitation = useMutation({
    ...revokeAuthInvitationMutation(),
    onSuccess: async () => {
      notify.success(messages.invitations.revoked)
      await refreshInvitations()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.invitations.revokeFailed)),
  })

  const openEditGroups = (member: Member) => {
    updateGroups.reset()
    setDraftGroupIds([...member.groupIds])
    setEditingMemberId(member.user.id)
  }

  const confirmAction = () => {
    if (!pendingAction || !actionMember) return
    const path = { path: { userId: actionMember.user.id } }
    if (pendingAction.type === "suspend") suspendMember.mutate(path)
    else reactivateMember.mutate(path)
    setPendingAction(null)
  }

  const noteFor = (member: Member, action: "assignGroups" | "suspend" | "reactivate") => {
    if (member.capabilities[action]) return null
    if (action === "assignGroups") return messages.notes.cannotAssign
    if (action === "reactivate") return messages.notes.cannotReactivate
    return member.user.id === currentUser?.id
      ? messages.notes.cannotSuspendSelf
      : messages.notes.cannotSuspend
  }

  const revokeInvite = (invitationId: string) => {
    setRevokingInvitationId(invitationId)
    revokeInvitation.mutate(
      { path: { invitationId } },
      { onSettled: () => setRevokingInvitationId(null) }
    )
  }

  const invitationRow = (invitation: Invitation) => (
    <PanelRow
      key={invitation.id}
      muted={invitation.status !== "pending"}
      leading={<IconTile icon={Mail} />}
      title={
        <>
          <span className="truncate">{invitation.email}</span>
          {isExpired(invitation) ? (
            <Pill tone="warn">{messages.invitations.status.expired}</Pill>
          ) : invitation.status === "pending" ? (
            <Pill tone="info">{messages.invitations.status.pending}</Pill>
          ) : invitation.status === "accepted" ? (
            <Pill tone="ok">{messages.invitations.status.accepted}</Pill>
          ) : (
            <Pill tone="muted">{messages.invitations.status.revoked}</Pill>
          )}
        </>
      }
      meta={
        <>
          <span>{messages.invitations.invited(format.relative(invitation.createdAt))}</span>
          {invitation.status === "pending" ? (
            <>
              <MetaDot />
              <span>
                {isExpired(invitation)
                  ? messages.invitations.expiredOn(format.date(invitation.expiresAt))
                  : messages.invitations.expiresOn(format.date(invitation.expiresAt))}
              </span>
            </>
          ) : null}
        </>
      }
      trailing={
        <>
          <span className="hidden md:inline-flex">
            <GroupChips groupIds={invitation.groupIds} groupsById={groupsById} />
          </span>
          {invitation.status === "pending" ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={revokingInvitationId === invitation.id}
              onClick={() => revokeInvite(invitation.id)}
              className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
            >
              {revokingInvitationId === invitation.id
                ? allMessages.common.revoking
                : allMessages.common.revoke}
            </Button>
          ) : null}
        </>
      }
    />
  )

  return (
    <SectionPage
      section="settings"
      page="members"
      title={messages.title}
      description={messages.description}
      actions={
        inviteOptions && disabledReason === null ? (
          <Button type="button" size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus />
            {messages.inviteButton}
          </Button>
        ) : null
      }
    >
      <Panel
        toolbar={
          <>
            <ToolbarTabs
              value={activeTab}
              onChange={setActiveTab}
              tabs={[
                { id: "members", label: messages.tabs.members, count: membersQuery.data?.total },
                {
                  id: "invitations",
                  label: messages.tabs.invitations,
                  count: invitationsQuery.data ? pendingInvitations.length : undefined,
                },
              ]}
            />
            {activeTab === "members" && members.length > 0 ? (
              <div className="relative ml-auto w-full sm:w-60">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={messages.search}
                  aria-label={messages.search}
                  className="h-8 pl-8 text-[0.8125rem]"
                />
              </div>
            ) : null}
          </>
        }
        footer={disabledReason && !inviteOptionsQuery.isPending ? disabledReason : undefined}
      >
        {activeTab === "members" ? (
          membersQuery.isPending ? (
            <PanelSkeleton rows={4} />
          ) : membersQuery.isError ? (
            <PanelEmpty
              tone="error"
              icon={UsersRound}
              title={messages.unavailable}
              description={apiErrorMessage(membersQuery.error, messages.loadFailed)}
            />
          ) : visibleMembers.length === 0 ? (
            <PanelEmpty
              icon={UsersRound}
              title={members.length === 0 ? messages.noneTitle : messages.noMatchTitle}
              description={
                members.length === 0 ? messages.noneDescription : messages.noMatchDescription
              }
            />
          ) : (
            visibleMembers.map((member) => {
              const name = displayName(member.user)
              const active = member.user.status === "active"
              const isSelf = member.user.id === currentUser?.id
              return (
                <PanelRow
                  key={member.user.id}
                  onClick={() => setSelectedMemberId(member.user.id)}
                  muted={!active}
                  leading={
                    <PersonAvatar
                      name={member.user.displayName}
                      email={member.user.email}
                      avatarUrl={member.user.avatarUrl}
                    />
                  }
                  title={
                    <>
                      <span className="truncate">{name}</span>
                      {isSelf ? <Pill>{messages.you}</Pill> : null}
                      {active ? null : <Pill tone="warn">{messages.status.suspended}</Pill>}
                    </>
                  }
                  meta={
                    name === member.user.email ? (
                      <span>{messages.joined(format.date(member.user.createdAt))}</span>
                    ) : (
                      <span className="truncate">{member.user.email}</span>
                    )
                  }
                  trailing={
                    <>
                      <span className="hidden md:inline-flex">
                        <GroupChips
                          groupIds={member.groupIds}
                          managedGroupIds={member.managedGroupIds}
                          groupsById={groupsById}
                        />
                      </span>
                      <MemberMenu
                        member={member}
                        name={name}
                        onOpen={() => setSelectedMemberId(member.user.id)}
                        onEditGroups={() => openEditGroups(member)}
                        onAction={(type) => setPendingAction({ type, memberId: member.user.id })}
                      />
                    </>
                  }
                />
              )
            })
          )
        ) : invitationsQuery.isPending ? (
          <PanelSkeleton rows={2} />
        ) : invitationsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Mail}
            title={messages.invitations.unavailable}
            description={apiErrorMessage(invitationsQuery.error, messages.invitations.loadFailed)}
          />
        ) : (
          <>
            {pendingInvitations.length === 0 ? (
              <PanelEmpty
                icon={Mail}
                title={messages.invitations.emptyTitle}
                description={messages.invitations.emptyDescription}
              />
            ) : (
              pendingInvitations.map(invitationRow)
            )}
            {showPastInvitations ? pastInvitations.map(invitationRow) : null}
            {pastInvitations.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowPastInvitations((shown) => !shown)}
                className="flex w-full px-4 py-2.5 text-left text-[0.8125rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {showPastInvitations
                  ? messages.invitations.hidePast
                  : messages.invitations.showPast(pastInvitations.length)}
              </button>
            ) : null}
          </>
        )}
      </Panel>

      {inviteOptions ? (
        <InviteDialog
          open={inviteOpen}
          onOpenChange={(open) => {
            setInviteOpen(open)
            if (open) createInvitation.reset()
          }}
          options={inviteOptions}
          isSubmitting={createInvitation.isPending}
          errorMessage={
            createInvitation.isError
              ? apiErrorMessage(createInvitation.error, messages.invite.createFailed)
              : null
          }
          onSubmit={(body) => createInvitation.mutate({ body })}
        />
      ) : null}

      <MemberSheet
        member={selectedMember}
        isSelf={selectedMember?.user.id === currentUser?.id}
        groupsById={groupsById}
        groupsNote={selectedMember ? noteFor(selectedMember, "assignGroups") : null}
        accessNote={
          selectedMember
            ? noteFor(
                selectedMember,
                selectedMember.user.status === "active" ? "suspend" : "reactivate"
              )
            : null
        }
        busy={suspendMember.isPending || reactivateMember.isPending}
        onClose={() => setSelectedMemberId(null)}
        onEditGroups={openEditGroups}
        onAction={(type, memberId) => setPendingAction({ type, memberId })}
      />

      <AlertDialog
        open={pendingAction !== null && actionMember !== null}
        onOpenChange={(open) => (open ? undefined : setPendingAction(null))}
      >
        <AlertDialogContent>
          {pendingAction && actionMember ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingAction.type === "suspend"
                    ? messages.confirm.suspendTitle(displayName(actionMember.user))
                    : messages.confirm.reactivateTitle(displayName(actionMember.user))}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingAction.type === "suspend"
                    ? messages.confirm.suspendDescription
                    : messages.confirm.reactivateDescription}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{allMessages.common.cancel}</AlertDialogCancel>
                <AlertDialogAction
                  className={cn(
                    pendingAction.type === "suspend" &&
                      "bg-destructive text-white hover:bg-destructive/90"
                  )}
                  onClick={confirmAction}
                >
                  {pendingAction.type === "suspend"
                    ? messages.confirm.suspend
                    : messages.confirm.reactivate}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={editingMember !== null}
        onOpenChange={(open) => (open ? undefined : setEditingMemberId(null))}
      >
        <DialogContent className="gap-6 sm:max-w-[28rem]">
          {editingMember ? (
            <>
              <DialogHeader>
                <DialogTitle>{messages.edit.title}</DialogTitle>
                <DialogDescription>
                  {messages.edit.description(displayName(editingMember.user))}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <GroupPicker
                  groups={assignableGroups ?? []}
                  selectedGroupIds={draftGroupIds}
                  lockedGroupIds={editingMember.managedGroupIds}
                  disabled={updateGroups.isPending}
                  onChange={setDraftGroupIds}
                  emptyMessage={messages.edit.noAssignable}
                />
                {updateGroups.isError ? (
                  <FormError>
                    {apiErrorMessage(updateGroups.error, messages.edit.updateFailed)}
                  </FormError>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEditingMemberId(null)}
                  disabled={updateGroups.isPending}
                >
                  {allMessages.common.cancel}
                </Button>
                <Button
                  type="button"
                  disabled={!editingMember.capabilities.assignGroups || updateGroups.isPending}
                  onClick={() =>
                    updateGroups.mutate({
                      path: { userId: editingMember.user.id },
                      body: { groupIds: draftGroupIds },
                    })
                  }
                >
                  {updateGroups.isPending ? <Loader2 className="animate-spin" /> : null}
                  {messages.edit.save}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={revealedLink !== null}
        onOpenChange={(open) => (open ? undefined : setRevealedLink(null))}
      >
        <DialogContent className="gap-6 sm:max-w-[28rem]">
          {revealedLink ? (
            <>
              <DialogHeader>
                <DialogTitle>{messages.link.title}</DialogTitle>
                <DialogDescription>
                  {messages.link.description(revealedLink.email)}
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <CopyField value={revealedLink.url} />
                <Warning>
                  {messages.link.warning}
                  {revealedLink.expiresAt
                    ? ` ${messages.link.expires(format.dateTime(revealedLink.expiresAt))}`
                    : ""}
                </Warning>
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => setRevealedLink(null)}>
                  {allMessages.common.done}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </SectionPage>
  )
}

function MemberMenu({
  member,
  name,
  onOpen,
  onEditGroups,
  onAction,
}: {
  readonly member: Member
  readonly name: string
  readonly onOpen: () => void
  readonly onEditGroups: () => void
  readonly onAction: (type: MemberAction) => void
}) {
  const messages = useSettingsMessages().members
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={messages.actionsFor(name)}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onOpen}>
          <PanelRight />
          {messages.viewDetails}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!member.capabilities.assignGroups} onSelect={onEditGroups}>
          <Pencil />
          {messages.editGroups}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {member.user.status === "active" ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={!member.capabilities.suspend}
            onSelect={() => onAction("suspend")}
          >
            <Ban />
            {messages.suspend}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={!member.capabilities.reactivate}
            onSelect={() => onAction("reactivate")}
          >
            <RotateCcw />
            {messages.reactivate}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface InviteBody {
  email: string
  groupIds?: string[]
  destinationId?: "atlas" | "app"
  revealLink?: boolean
}

function InviteDialog({
  open,
  onOpenChange,
  options,
  isSubmitting,
  errorMessage,
  onSubmit,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly options: InvitationOptions
  readonly isSubmitting: boolean
  readonly errorMessage: string | null
  readonly onSubmit: (body: InviteBody) => void
}) {
  const allMessages = useSettingsMessages()
  const messages = allMessages.members.invite
  const [email, setEmail] = useState("")
  const [destinationId, setDestinationId] = useState("")
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [revealLink, setRevealLink] = useState(false)

  // Each opening starts empty.
  useEffect(() => {
    if (!open) return
    setEmail("")
    setDestinationId("")
    setGroupIds([])
    setRevealLink(false)
  }, [open])

  // Drop selected groups the person can no longer give, so a submit never sends a stale id.
  useEffect(() => {
    const allowed = new Set(options.groups.map((group) => group.id))
    setGroupIds((previous) => previous.filter((groupId) => allowed.has(groupId)))
  }, [options])

  const destinations = options.destinations
  const destination = destinations.some((candidate) => candidate.id === destinationId)
    ? destinationId
    : (options.defaultDestinationId ?? destinations[0]?.id ?? "")
  const canSubmit =
    email.trim().length > 0 &&
    (destinations.length === 0 || destination.length > 0) &&
    (groupIds.length > 0 || options.canInviteWithoutGroups) &&
    !isSubmitting

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit({
      email: email.trim(),
      ...(groupIds.length > 0 ? { groupIds } : {}),
      ...(destination === "atlas" || destination === "app" ? { destinationId: destination } : {}),
      ...(revealLink ? { revealLink: true } : {}),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-6 sm:max-w-[30rem]">
        <form onSubmit={submit} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{messages.title}</DialogTitle>
            <DialogDescription>{messages.description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-5">
            <Field label={messages.email} htmlFor="invite-email">
              <Input
                id="invite-email"
                type="email"
                value={email}
                autoComplete="off"
                autoFocus
                onChange={(event) => setEmail(event.target.value)}
                disabled={isSubmitting}
                placeholder={messages.emailPlaceholder}
              />
            </Field>
            {destinations.length > 1 ? (
              <Field label={messages.destination}>
                <Select
                  value={destination || undefined}
                  onValueChange={setDestinationId}
                  disabled={isSubmitting}
                >
                  <SelectTrigger aria-label={messages.destination} className="w-full">
                    <SelectValue placeholder={messages.destinationPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field
              label={messages.groups}
              hint={
                options.groups.length > 0 && !options.canInviteWithoutGroups
                  ? messages.groupsRequired
                  : undefined
              }
            >
              <GroupPicker
                groups={options.groups}
                selectedGroupIds={groupIds}
                onChange={setGroupIds}
                disabled={isSubmitting}
                emptyMessage={messages.noGroups}
              />
            </Field>
            <label
              htmlFor="invite-reveal-link"
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted/40"
            >
              <Checkbox
                id="invite-reveal-link"
                checked={revealLink}
                onCheckedChange={(checked) => setRevealLink(checked === true)}
                disabled={isSubmitting}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-[0.8125rem] font-medium">{messages.revealLink}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {messages.revealLinkHint}
                </span>
              </span>
            </label>
            {errorMessage ? <FormError>{errorMessage}</FormError> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {allMessages.common.cancel}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? <Loader2 className="animate-spin" /> : null}
              {messages.send}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MemberSheet({
  member,
  isSelf,
  groupsById,
  groupsNote,
  accessNote,
  busy,
  onClose,
  onEditGroups,
  onAction,
}: {
  readonly member: Member | null
  readonly isSelf: boolean
  readonly groupsById: ReadonlyMap<string, AuthGroupOption>
  readonly groupsNote: string | null
  readonly accessNote: string | null
  readonly busy: boolean
  readonly onClose: () => void
  readonly onEditGroups: (member: Member) => void
  readonly onAction: (type: MemberAction, memberId: string) => void
}) {
  const messages = useSettingsMessages().members
  const format = useFormat()

  return (
    <Sheet open={member !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        {member ? (
          <>
            <div className="flex flex-col gap-4 border-b border-border p-6 pr-12">
              <PersonAvatar
                name={member.user.displayName}
                email={member.user.email}
                avatarUrl={member.user.avatarUrl}
                size="lg"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <SheetTitle className="truncate text-lg tracking-[-0.01em]">
                    {displayName(member.user)}
                  </SheetTitle>
                  {isSelf ? <Pill>{messages.you}</Pill> : null}
                  {member.user.status === "active" ? (
                    <Pill tone="ok">{messages.status.active}</Pill>
                  ) : (
                    <Pill tone="warn">{messages.status.suspended}</Pill>
                  )}
                </div>
                <SheetDescription className="truncate">{member.user.email}</SheetDescription>
              </div>
            </div>
            <div className="flex-1 divide-y divide-border overflow-auto px-6">
              <SheetSection
                title={messages.sheet.groups}
                description={messages.sheet.groupsDescription}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!member.capabilities.assignGroups}
                    onClick={() => onEditGroups(member)}
                  >
                    <Pencil />
                    {messages.sheet.edit}
                  </Button>
                }
                note={groupsNote}
              >
                <GroupChips
                  groupIds={member.groupIds}
                  managedGroupIds={member.managedGroupIds}
                  groupsById={groupsById}
                />
              </SheetSection>
              <SheetSection
                title={messages.sheet.access}
                description={
                  member.user.status === "active"
                    ? messages.sheet.suspendHint
                    : messages.sheet.reactivateHint
                }
                action={
                  member.user.status === "active" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!member.capabilities.suspend || busy}
                      onClick={() => onAction("suspend", member.user.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Ban />
                      {messages.suspend}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!member.capabilities.reactivate || busy}
                      onClick={() => onAction("reactivate", member.user.id)}
                    >
                      <RotateCcw />
                      {messages.reactivate}
                    </Button>
                  )
                }
                note={accessNote}
              />
              <SheetSection title={messages.sheet.details}>
                <dl className="grid grid-cols-2 gap-4 text-[0.8125rem]">
                  <div>
                    <dt className="text-muted-foreground">{messages.sheet.created}</dt>
                    <dd className="mt-1 font-medium">{format.date(member.user.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{messages.sheet.updated}</dt>
                    <dd className="mt-1 font-medium">{format.date(member.user.updatedAt)}</dd>
                  </div>
                </dl>
              </SheetSection>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function SheetSection({
  title,
  description,
  action,
  note,
  children,
}: {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly note?: string | null
  readonly children?: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3 py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </section>
  )
}
