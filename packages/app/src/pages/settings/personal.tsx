import { getAuthAccessManagementOptionsOptions } from "@sixb/client/hooks"
import { Button, ThemePicker } from "@sixb/ui/components"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { useQuery } from "@tanstack/react-query"
import { Loader2, LogOut } from "lucide-react"
import { useMemo, useState } from "react"
import { useCurrentUser, useSignOut } from "../../session"
import { notify, SectionPage } from "../section-page"
import { PageSection, Panel } from "../section-ui"
import { type AuthGroupOption, GroupChips, PersonAvatar } from "./controls"
import { useSettingsMessages } from "./messages"
import { SessionsSection } from "./sessions"

/**
 * Settings › Personal: who you are in this project, your groups, how the app looks, and where
 * you're signed in.
 */
export function SettingsPersonalPage() {
  const messages = useSettingsMessages().personal
  const user = useCurrentUser()
  const signOut = useSignOut()
  // A shell without the theme provider has no theme to choose.
  const themed = useOptionalTheme() !== null
  const [signingOut, setSigningOut] = useState(false)
  // The groups this person holds, with their labels.
  const options = useQuery({ ...getAuthAccessManagementOptionsOptions(), retry: false })
  const groupsById = useMemo(
    () => new Map<string, AuthGroupOption>((options.data?.groups ?? []).map((g) => [g.id, g])),
    [options.data]
  )

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
          <Panel footer={messages.note}>
            <div className="flex items-center gap-4 px-5 py-5">
              <PersonAvatar
                name={user.displayName}
                email={user.email}
                avatarUrl={user.avatarUrl}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.9375rem] font-semibold tracking-[-0.01em]">
                  {user.displayName ?? user.email}
                </p>
                {user.displayName ? (
                  <p className="truncate text-[0.8125rem] text-muted-foreground">{user.email}</p>
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
      <SessionsSection />
    </SectionPage>
  )
}
