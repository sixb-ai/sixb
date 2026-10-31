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
  listAuthServiceAccountsOptions,
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Ban,
  ChevronRight,
  Link2,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RotateCcw,
  UsersRound,
  X,
} from "lucide-react"
import { type ReactNode, type SubmitEvent, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useCurrentUser, useSessionAccess } from "../../session"
import { notify, SectionPage } from "../section-page"
import {
  apiErrorMessage,
  Field,
  IconTile,
  MetaDot,
  PageTabs,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  useFormat,
} from "../section-ui"
import {
  type AuthGroupOption,
  CopyField,
  FormError,
  GroupChips,
  GroupPicker,
  groupLabel,
  PersonAvatar,
  Warning,
} from "./controls"
import { type SettingsMessages, useSettingsMessages } from "./messages"
import { ServiceAccountsTab } from "./service-accounts"

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

type MembersTab = "people" | "groups" | "service-accounts"

/**
 * Settings › Members: who can sign in and the groups that decide what they can open, with the
 * service accounts that act for automation. Each tab shows to whoever may manage it.
 */
export function SettingsMembersPage() {
  const allMessages = useSettingsMessages()
  const messages = allMessages.members
  const queryClient = useQueryClient()
  const currentUser = useCurrentUser()
  const access = useSessionAccess()
  const format = useFormat()
  const [searchParams, setSearchParams] = useSearchParams()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [createAccountOpen, setCreateAccountOpen] = useState(false)
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

  // The tabs this person may use, in order; the address names one, or the first opens.
  const tabs: readonly MembersTab[] = [
    ...(access?.members ? (["people", "groups"] as const) : []),
    ...(access?.serviceAccounts ? (["service-accounts"] as const) : []),
  ]
  const requested = searchParams.get("tab")
  const tab = tabs.find((candidate) => candidate === requested) ?? tabs[0] ?? "people"
  const groupFilter = tab === "people" ? searchParams.get("group") : null
  const showTab = (next: MembersTab, group?: string) => {
    setSearchParams(next === tabs[0] && !group ? {} : { tab: next, ...(group ? { group } : {}) }, {
      replace: false,
    })
  }
  const filterByGroup = (group: string | null) =>
    setSearchParams(group ? { tab: "people", group } : {}, { replace: true })

  const optionsQuery = useQuery({ ...getAuthMembershipOptionsOptions(), retry: false })
  const membersQuery = useQuery({ ...listAuthMembersOptions(memberListOptions), retry: false })
  const inviteOptionsQuery = useQuery({ ...getAuthInvitationOptionsOptions(), retry: false })
  const invitationsQuery = useQuery({
    ...listAuthInvitationsOptions(invitationListOptions),
    retry: false,
  })
  // For the tab's count; the tab itself reads the same list.
  const accountsQuery = useQuery({
    ...listAuthServiceAccountsOptions(),
    enabled: access?.serviceAccounts === true,
    retry: false,
  })

  const assignableGroups = optionsQuery.data?.groups
  const members = membersQuery.data?.members ?? []
  const groupsById = useMemo(() => {
    // Members can hold groups the caller cannot assign; invitation options often know their labels.
    const all = [...(inviteOptionsQuery.data?.groups ?? []), ...(assignableGroups ?? [])]
    return new Map<string, AuthGroupOption>(all.map((group) => [group.id, group]))
  }, [assignableGroups, inviteOptionsQuery.data])
  const groups = useMemo(
    () => [...groupsById.values()].sort((a, b) => groupLabel(a).localeCompare(groupLabel(b))),
    [groupsById]
  )
  const inviteOptions = inviteOptionsQuery.data
  const invitations = invitationsQuery.data?.invitations ?? []
  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending")
  const pastInvitations = invitations.filter((invitation) => invitation.status !== "pending")
  const disabledReason = inviteOptionsQuery.isPending
    ? null
    : inviteDisabledReason(inviteOptions, messages.invite)

  const inGroup = (groupIds: readonly string[]) => !groupFilter || groupIds.includes(groupFilter)
  const visibleMembers = members.filter((member) => inGroup(member.groupIds))
  // Someone invited is one of the people, not yet joined: they follow those who have.
  const visibleInvitations = pendingInvitations.filter((invitation) => inGroup(invitation.groupIds))

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
      // The invitation leads the people, where it now lives.
      if (tab !== "people") showTab("people")
      await refreshInvitations()
    },
  })

  const renewInvitation = useMutation({
    ...createAuthInvitationMutation(),
    onSuccess: async (result) => {
      const { email } = result.invitation
      const link = result.delivery.link
      if (link) {
        // Copied where the browser allows it, shown to copy by hand where it does not.
        const copied = await navigator.clipboard?.writeText(link.url).then(
          () => true,
          () => false
        )
        if (copied) notify.success(messages.invitations.linkCopied(email))
        else setRevealedLink({ ...link, email })
      } else {
        notify.success(messages.invitations.sentAgain(email))
      }
      await refreshInvitations()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.invite.createFailed)),
  })
  const renewInvite = (invitation: Invitation) =>
    renewInvitation.mutate({
      body: { email: invitation.email, groupIds: [...invitation.groupIds], revealLink: true },
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

  const invitationRow = (invitation: Invitation) => {
    const pending = invitation.status === "pending"
    const renewing =
      renewInvitation.isPending && renewInvitation.variables?.body.email === invitation.email
    return (
      <PeopleRow
        key={invitation.id}
        invited
        muted={!pending}
        avatar={<InviteeAvatar email={invitation.email} />}
        name={invitation.email}
        detail={
          isExpired(invitation)
            ? messages.invitations.expiredOn(format.date(invitation.expiresAt))
            : pending
              ? messages.invitations.invited(format.relative(invitation.createdAt))
              : invitation.status === "accepted"
                ? messages.invitations.status.accepted
                : messages.invitations.status.revoked
        }
        groups={<GroupChips groupIds={invitation.groupIds} groupsById={groupsById} />}
        status={
          pending ? (
            <button
              type="button"
              disabled={renewing}
              onClick={() => renewInvite(invitation)}
              className="text-[0.8125rem] font-medium text-foreground hover:underline hover:underline-offset-4 disabled:opacity-60"
            >
              {renewing ? messages.invitations.renewing : messages.invitations.copyNewLink}
            </button>
          ) : null
        }
        menu={
          pending ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  aria-label={messages.actionsFor(invitation.email)}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem disabled={renewing} onSelect={() => renewInvite(invitation)}>
                  <Link2 />
                  {messages.invitations.copyNewLink}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={revokingInvitationId === invitation.id}
                  onSelect={() => revokeInvite(invitation.id)}
                >
                  <Ban />
                  {allMessages.common.revoke}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      />
    )
  }

  const memberRow = (member: Member) => {
    const name = displayName(member.user)
    const active = member.user.status === "active"
    const isSelf = member.user.id === currentUser?.id
    return (
      <PeopleRow
        key={member.user.id}
        onOpen={() => setSelectedMemberId(member.user.id)}
        muted={!active}
        avatar={
          <MemberAvatar
            name={member.user.displayName}
            email={member.user.email}
            avatarUrl={member.user.avatarUrl}
          />
        }
        name={
          <>
            {name}
            {isSelf ? (
              <span className="font-normal text-muted-foreground"> {messages.youMark}</span>
            ) : null}
          </>
        }
        detail={
          name === member.user.email
            ? messages.joined(format.date(member.user.createdAt))
            : member.user.email
        }
        groups={
          <GroupChips
            groupIds={member.groupIds}
            managedGroupIds={member.managedGroupIds}
            groupsById={groupsById}
          />
        }
        status={
          !active ? (
            <span className="text-amber-700 dark:text-amber-400">{messages.status.suspended}</span>
          ) : member.lastActiveAt === undefined ? (
            <span className="text-muted-foreground">{messages.neverSignedIn}</span>
          ) : Date.now() - Date.parse(member.lastActiveAt) < ACTIVE_NOW_MS ? (
            <span className="text-foreground/80">{messages.activeNow}</span>
          ) : (
            <span className="text-muted-foreground">{format.relative(member.lastActiveAt)}</span>
          )
        }
        menu={
          <MemberMenu
            member={member}
            name={name}
            onOpen={() => setSelectedMemberId(member.user.id)}
            onEditGroups={() => openEditGroups(member)}
            onAction={(type) => setPendingAction({ type, memberId: member.user.id })}
          />
        }
      />
    )
  }

  const counts: Record<MembersTab, number | undefined> = {
    people: membersQuery.data?.total,
    groups: optionsQuery.data ? groups.length : undefined,
    "service-accounts": accountsQuery.data?.serviceAccounts.length,
  }
  const labels: Record<MembersTab, string> = {
    people: messages.tabs.people,
    groups: messages.tabs.groups,
    "service-accounts": messages.tabs.serviceAccounts,
  }
  const tabBar =
    tabs.length > 1 ? (
      <PageTabs
        variant="segmented"
        tabs={tabs.map((id) => ({ id, label: labels[id], count: counts[id] }))}
        value={tab}
        onChange={(next) => showTab(next)}
      />
    ) : null

  const headerAction =
    tab === "service-accounts" ? (
      <Button type="button" size="sm" onClick={() => setCreateAccountOpen(true)}>
        <Plus />
        {allMessages.serviceAccounts.newAccount}
      </Button>
    ) : inviteOptions && disabledReason === null ? (
      <Button type="button" size="sm" onClick={() => setInviteOpen(true)}>
        <Plus />
        {messages.inviteButton}
      </Button>
    ) : null

  return (
    <SectionPage
      section="settings"
      page="members"
      title={messages.title}
      description={messages.description}
      actions={headerAction}
    >
      {tabBar}
      {tab === "service-accounts" ? (
        <ServiceAccountsTab
          createOpen={createAccountOpen}
          onCreateOpenChange={setCreateAccountOpen}
        />
      ) : tab === "groups" ? (
        <Panel footer={messages.groups.footnote}>
          {optionsQuery.isPending || membersQuery.isPending ? (
            <PanelSkeleton rows={3} />
          ) : groups.length === 0 ? (
            <PanelEmpty
              icon={UsersRound}
              title={messages.groups.noneTitle}
              description={messages.groups.noneDescription}
            />
          ) : (
            groups.map((group) => (
              <GroupRow
                key={group.id}
                group={group}
                members={members.filter((member) => member.groupIds.includes(group.id))}
                invited={
                  pendingInvitations.filter((invitation) => invitation.groupIds.includes(group.id))
                    .length
                }
                onOpen={() => showTab("people", group.id)}
              />
            ))
          )}
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {groupFilter ? (
            <span className="inline-flex h-[30px] items-center gap-1.5 self-start rounded-lg bg-muted pr-[3px] pl-2.5 text-[0.8125rem]">
              <span className="text-muted-foreground">{messages.groupFilter}</span>
              <span className="font-medium">
                {groupsById.get(groupFilter)
                  ? groupLabel(groupsById.get(groupFilter)!)
                  : groupFilter}
              </span>
              <button
                type="button"
                aria-label={messages.clearGroupFilter}
                onClick={() => filterByGroup(null)}
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ) : null}
          <div className="overflow-hidden rounded-2xl border border-border/80 bg-card">
            {membersQuery.isPending || invitationsQuery.isPending ? (
              <PanelSkeleton rows={4} />
            ) : membersQuery.isError ? (
              <PanelEmpty
                tone="error"
                icon={UsersRound}
                title={messages.unavailable}
                description={apiErrorMessage(membersQuery.error, messages.loadFailed)}
              />
            ) : visibleMembers.length === 0 && visibleInvitations.length === 0 ? (
              <PanelEmpty
                icon={UsersRound}
                title={groupFilter ? messages.noMatchTitle : messages.noneTitle}
                description={groupFilter ? messages.noMatchDescription : messages.noneDescription}
              />
            ) : (
              <>
                {visibleMembers.map(memberRow)}
                {visibleInvitations.map(invitationRow)}
              </>
            )}
            {showPastInvitations && !groupFilter ? pastInvitations.map(invitationRow) : null}
            {pastInvitations.length > 0 && !groupFilter ? (
              <button
                type="button"
                onClick={() => setShowPastInvitations((shown) => !shown)}
                className="flex w-full border-t border-border/60 px-[18px] py-2.5 text-left text-[0.8125rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {showPastInvitations
                  ? messages.invitations.hidePast
                  : messages.invitations.showPast(pastInvitations.length)}
              </button>
            ) : null}
            {disabledReason && !inviteOptionsQuery.isPending ? (
              <div className="border-t border-border/60 bg-muted/40 px-[18px] py-3 text-[0.8125rem] text-muted-foreground">
                {disabledReason}
              </div>
            ) : null}
          </div>
        </div>
      )}

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
                  variant={pendingAction.type === "suspend" ? "destructive" : "default"}
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

// Signed-in activity is recorded about once a minute, so a few minutes reads as now.
const ACTIVE_NOW_MS = 5 * 60_000

/**
 * One person in the People table: who, their groups, when they were last here, and their
 * actions. A member's row opens their details; an invitation's has none to open.
 */
function PeopleRow({
  avatar,
  name,
  detail,
  groups,
  status,
  menu,
  onOpen,
  muted,
  invited,
}: {
  readonly avatar: ReactNode
  readonly name: ReactNode
  readonly detail: ReactNode
  readonly groups: ReactNode
  readonly status: ReactNode
  readonly menu: ReactNode
  readonly onOpen?: () => void
  readonly muted?: boolean
  readonly invited?: boolean
}) {
  const who = (
    <>
      {avatar}
      <span className="flex min-w-0 flex-col leading-[1.3]">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-[0.78rem] text-muted-foreground">{detail}</span>
      </span>
    </>
  )
  return (
    <div
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_32px] items-center gap-4 border-t border-border/60 px-[18px] py-3 text-sm first:border-t-0 md:grid-cols-[minmax(220px,1.6fr)_minmax(180px,1.2fr)_140px_32px]",
        invited && "bg-muted/30",
        onOpen && "hover:bg-muted/40"
      )}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className={cn("flex min-w-0 items-center gap-3 text-left", muted && "opacity-60")}
        >
          {who}
        </button>
      ) : (
        <span className={cn("flex min-w-0 items-center gap-3", muted && "opacity-60")}>{who}</span>
      )}
      <span className="hidden min-w-0 md:flex">{groups}</span>
      <span className="hidden text-[0.8125rem] md:block">{status}</span>
      <span className="flex justify-end">{menu}</span>
    </div>
  )
}

// Muted, distinct tones; a person keeps theirs, chosen by their email.
const AVATAR_TONES = ["#4f8233", "#3d5a99", "#8a5a2b", "#6b4c9a", "#2f7d78", "#9a4c5f", "#5f6b2f"]

function toneOf(email: string): string {
  let hash = 0
  for (const char of email.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]!
}

/** A member's picture, or their initial on their tone. */
function MemberAvatar({
  name,
  email,
  avatarUrl,
}: {
  readonly name?: string
  readonly email: string
  readonly avatarUrl?: string
}) {
  // A picture that does not load, such as one the app's content policy blocks, shows the initial.
  const [broken, setBroken] = useState(false)
  if (avatarUrl && !broken) {
    return (
      <img
        src={avatarUrl}
        alt=""
        onError={() => setBroken(true)}
        className="size-[34px] shrink-0 rounded-[10px] object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden
      className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] text-sm font-semibold text-white"
      style={{ background: toneOf(email) }}
    >
      {(name || email).charAt(0).toUpperCase()}
    </span>
  )
}

/** Someone invited, not yet a member: a dashed outline where their picture will be. */
function InviteeAvatar({ email }: { readonly email: string }) {
  return (
    <span
      aria-hidden
      className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] border border-dashed border-foreground/25 bg-background text-sm font-semibold text-muted-foreground"
    >
      {email.charAt(0).toUpperCase()}
    </span>
  )
}

/** A group with the people in it: who and how many. */
function GroupRow({
  group,
  members,
  invited,
  onOpen,
}: {
  readonly group: AuthGroupOption
  readonly members: readonly Member[]
  readonly invited: number
  readonly onOpen: () => void
}) {
  const messages = useSettingsMessages().members.groups
  const label = groupLabel(group)
  const shown = members.slice(0, 4)
  return (
    <PanelRow
      onClick={onOpen}
      leading={<IconTile icon={UsersRound} />}
      title={<span className="truncate">{label}</span>}
      meta={
        <>
          {group.description ? (
            <>
              <span className="truncate">{group.description}</span>
              <MetaDot />
            </>
          ) : null}
          <span>{members.length === 0 ? messages.nobody : messages.people(members.length)}</span>
          {invited > 0 ? (
            <>
              <MetaDot />
              <span>{messages.invited(invited)}</span>
            </>
          ) : null}
        </>
      }
      trailing={
        <>
          {shown.length > 0 ? (
            <span className="hidden -space-x-1.5 sm:flex" aria-hidden>
              {shown.map((member) => (
                <span key={member.user.id} className="rounded-full ring-2 ring-card">
                  <PersonAvatar
                    size="sm"
                    name={member.user.displayName}
                    email={member.user.email}
                    avatarUrl={member.user.avatarUrl}
                  />
                </span>
              ))}
            </span>
          ) : null}
          <ChevronRight
            className="size-4 text-muted-foreground/60"
            aria-label={messages.showPeople(label)}
          />
        </>
      }
    />
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
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [revealLink, setRevealLink] = useState(false)

  // Each opening starts empty.
  useEffect(() => {
    if (!open) return
    setEmail("")
    setGroupIds([])
    setRevealLink(false)
  }, [open])

  // Drop selected groups the person can no longer give, so a submit never sends a stale id.
  useEffect(() => {
    const allowed = new Set(options.groups.map((group) => group.id))
    setGroupIds((previous) => previous.filter((groupId) => allowed.has(groupId)))
  }, [options])

  const canSubmit =
    email.trim().length > 0 &&
    (groupIds.length > 0 || options.canInviteWithoutGroups) &&
    !isSubmitting

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    onSubmit({
      email: email.trim(),
      ...(groupIds.length > 0 ? { groupIds } : {}),
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
