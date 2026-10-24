import {
  getAgentOptions,
  getAgentPreferencesOptions,
  getAgentPreferencesQueryKey,
  getAuthAccessManagementOptionsOptions,
  getAuthProfileOptions,
  getAuthProfileQueryKey,
  getAuthSessionQueryKey,
  updateAgentPreferencesMutation,
  updateAuthProfileMutation,
} from "@sixb/client/hooks"
import { Button, Input, ThemePicker } from "@sixb/ui/components"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, LogOut, Pencil } from "lucide-react"
import { type SubmitEvent, useEffect, useMemo, useRef, useState } from "react"
import { AGENT_APPROVAL_MODES, type AgentApprovalMode } from "../../agent/approvals"
import { APPROVAL_MODE_ICONS } from "../../agent/components/approval-mode-chip"
import { useAgentMessages } from "../../agent/i18n"
import { useCurrentUser, useSignOut } from "../../session"
import { notify, SectionPage } from "../section-page"
import { apiErrorMessage, PageSection, Panel } from "../section-ui"
import { type AuthGroupOption, GroupChips, PersonAvatar } from "./controls"
import { useSettingsMessages } from "./messages"
import { SessionsSection } from "./sessions"

/**
 * Settings › Personal: who you are in this project, your groups, how the app looks, what the agent
 * may change without asking, and where you're signed in.
 */
export function SettingsPersonalPage() {
  const messages = useSettingsMessages().personal
  const user = useCurrentUser()
  const signOut = useSignOut()
  // A shell without the theme provider has no theme to choose.
  const themed = useOptionalTheme() !== null
  const [signingOut, setSigningOut] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const editNameButton = useRef<HTMLButtonElement>(null)
  const refocusEditName = useRef(false)
  // The groups this person holds, with their labels.
  const options = useQuery({ ...getAuthAccessManagementOptionsOptions(), retry: false })
  const groupsById = useMemo(
    () => new Map<string, AuthGroupOption>((options.data?.groups ?? []).map((g) => [g.id, g])),
    [options.data]
  )
  // Your name stays read-only until the profile says the identity provider does not set it.
  const profile = useQuery({ ...getAuthProfileOptions(), enabled: user !== null, retry: false })
  const nameManaged = profile.data?.managedFields.includes("displayName") ?? false
  const nameEditable = profile.data !== undefined && !nameManaged

  // Leaving the form gives focus back to the button that opened it.
  useEffect(() => {
    if (!editingName && refocusEditName.current) {
      refocusEditName.current = false
      editNameButton.current?.focus()
    }
  }, [editingName])

  const stopEditingName = () => {
    refocusEditName.current = true
    setEditingName(false)
  }

  const handleSignOut = () => {
    setSigningOut(true)
    signOut().catch(() => {
      setSigningOut(false)
      notify.error(messages.signOutFailed)
    })
  }

  return (
    <SectionPage
      section="settings"
      page="personal"
      title={messages.title}
      description={messages.description}
    >
      {user ? (
        <PageSection>
          <Panel footer={nameManaged ? messages.noteManagedName : messages.note}>
            <div className="flex items-center gap-4 px-5 py-5">
              <PersonAvatar
                name={user.displayName}
                email={user.email}
                avatarUrl={user.avatarUrl}
                size="lg"
              />
              {editingName ? (
                <NameForm displayName={user.displayName} onDone={stopEditingName} />
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1">
                      <p className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em]">
                        {user.displayName ?? user.email}
                      </p>
                      {nameEditable ? (
                        <Button
                          ref={editNameButton}
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-muted-foreground"
                          aria-label={messages.editName}
                          onClick={() => setEditingName(true)}
                        >
                          <Pencil />
                        </Button>
                      ) : null}
                    </div>
                    {user.displayName ? (
                      <p className="truncate text-[0.8125rem] text-muted-foreground">
                        {user.email}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={signingOut}
                    onClick={handleSignOut}
                  >
                    {signingOut ? <Loader2 className="animate-spin" /> : <LogOut />}
                    {signingOut ? messages.signingOut : messages.signOut}
                  </Button>
                </>
              )}
            </div>
            <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
              <span className="w-28 shrink-0 text-[0.8125rem] text-muted-foreground">
                {messages.groups}
              </span>
              {user.groupIds.length > 0 ? (
                <GroupChips groupIds={user.groupIds} groupsById={groupsById} />
              ) : (
                <span className="text-[0.8125rem] text-muted-foreground">{messages.noGroups}</span>
              )}
            </div>
          </Panel>
        </PageSection>
      ) : null}
      {themed ? (
        <PageSection title={messages.appearance} description={messages.appearanceDescription}>
          <ThemePicker labels className="self-start" />
        </PageSection>
      ) : null}
      <ApprovalModeSection />
      <SessionsSection />
    </SectionPage>
  )
}

/** Edits your name in place of it. An empty name clears it, and the email shows instead. */
function NameForm({
  displayName,
  onDone,
}: {
  readonly displayName?: string
  readonly onDone: () => void
}) {
  const messages = useSettingsMessages()
  const queryClient = useQueryClient()

  const save = useMutation({
    ...updateAuthProfileMutation(),
    onSuccess: async (updated) => {
      queryClient.setQueryData(getAuthProfileQueryKey(), updated)
      // The header reads the session, which carries the name.
      await queryClient.invalidateQueries({ queryKey: getAuthSessionQueryKey() })
      onDone()
      notify.success(messages.personal.nameSaved)
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.personal.nameSaveFailed)),
  })

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const typed = String(new FormData(event.currentTarget).get("displayName") ?? "")
    save.mutate({ body: { displayName: typed } })
  }

  return (
    <form
      onSubmit={submit}
      className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center"
    >
      <Input
        name="displayName"
        defaultValue={displayName}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation()
            onDone()
          }
        }}
        autoComplete="name"
        autoFocus
        placeholder={messages.personal.namePlaceholder}
        aria-label={messages.personal.name}
        className="h-8 text-sm sm:flex-1"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : null}
          {messages.personal.saveName}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={save.isPending}
          onClick={onDone}
        >
          {messages.common.cancel}
        </Button>
      </div>
    </form>
  )
}

/**
 * Your approval mode where you choose none: new conversations, and those you never switched. Shown
 * only in a project with an agent; a choice saves at once.
 */
function ApprovalModeSection() {
  const messages = useSettingsMessages().personal
  const modes = useAgentMessages().approvalModes.modes
  const queryClient = useQueryClient()
  const agent = useQuery({ ...getAgentOptions(), retry: false, staleTime: 5 * 60_000 })
  const preferences = useQuery({
    ...getAgentPreferencesOptions(),
    enabled: agent.data !== undefined,
    retry: false,
  })

  const save = useMutation({
    ...updateAgentPreferencesMutation(),
    onSuccess: (updated) => {
      queryClient.setQueryData(getAgentPreferencesQueryKey(), updated)
      notify.success(messages.approvalsSaved)
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.approvalsSaveFailed)),
  })
  if (!agent.data || !preferences.data) return null

  // The mode being saved shows at once; a failure puts the saved one back.
  const current: AgentApprovalMode =
    save.isPending && save.variables
      ? save.variables.body.approvalMode
      : preferences.data.approvalMode

  return (
    <PageSection title={messages.approvals} description={messages.approvalsDescription}>
      <Panel>
        <div role="radiogroup" aria-label={messages.approvals} className="divide-y divide-border">
          {AGENT_APPROVAL_MODES.map((mode) => {
            const Icon = APPROVAL_MODE_ICONS[mode]
            const selected = mode === current
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={save.isPending}
                onClick={() => {
                  if (!selected) save.mutate({ body: { approvalMode: mode } })
                }}
                className="flex w-full items-center gap-4 px-5 py-3.5 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset disabled:cursor-default"
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-4",
                    mode === "auto" && "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                  )}
                >
                  <Icon aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.8125rem] font-medium">{modes[mode].label}</span>
                  <span className="block text-[0.8125rem] leading-5 text-muted-foreground">
                    {modes[mode].description}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-primary" : "border-input"
                  )}
                >
                  {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
                </span>
              </button>
            )
          })}
        </div>
      </Panel>
    </PageSection>
  )
}
