import { client } from "@sixb/client"
import {
  createAuthPersonalAccessTokenMutation,
  getAuthAccessManagementOptionsOptions,
  getAuthAccessManagementOptionsQueryKey,
  listAuthAccessTokensOptions,
  listAuthAccessTokensQueryKey,
  revokeAuthAccessTokenMutation,
} from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, Plus, SquareTerminal } from "lucide-react"
import { useMemo, useState } from "react"
import { notify, SectionPage } from "../section-page"
import {
  apiErrorMessage,
  CopyButton,
  IconTile,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
} from "../section-ui"
import { type CreatedTokenState, TokenFormDialog, TokenRows } from "./controls"
import { useSettingsMessages } from "./messages"

/** Settings › Developers: your access tokens, and signing in to the CLI. */
export function SettingsDevelopersPage() {
  const allMessages = useSettingsMessages()
  const messages = allMessages.developers
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [created, setCreated] = useState<CreatedTokenState | null>(null)
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null)

  const optionsQuery = useQuery({ ...getAuthAccessManagementOptionsOptions(), retry: false })
  const tokensQuery = useQuery({ ...listAuthAccessTokensOptions(), retry: false })

  const groups = optionsQuery.data?.groups
  const tokens = tokensQuery.data?.accessTokens ?? []
  const groupsById = useMemo(() => new Map((groups ?? []).map((g) => [g.id, g])), [groups])
  const allGroupIds = useMemo(() => (groups ?? []).map((group) => group.id), [groups])
  const apiUrl = client.getConfig().baseUrl ?? window.location.origin

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthAccessManagementOptionsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listAuthAccessTokensQueryKey() }),
    ])

  const createToken = useMutation({
    ...createAuthPersonalAccessTokenMutation(),
    onSuccess: async (result) => {
      setCreated({ tokenValue: result.tokenValue, name: result.accessToken.name })
      await refresh()
    },
  })

  const revokeToken = useMutation({
    ...revokeAuthAccessTokenMutation(),
    onSuccess: async () => {
      notify.success(messages.revoked)
      await refresh()
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.revokeFailed)),
  })

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open)
    if (open) {
      createToken.reset()
      setCreated(null)
    } else {
      // Forget the revealed value after the exit animation, so the form never flashes back.
      window.setTimeout(() => setCreated(null), 200)
    }
  }

  const newTokenButton = (
    <Button type="button" size="sm" onClick={() => handleDialogChange(true)}>
      <Plus />
      {messages.newToken}
    </Button>
  )

  return (
    <SectionPage
      section="settings"
      page="developers"
      title={messages.title}
      description={messages.description}
    >
      <PageSection
        title={messages.tokensTitle}
        description={messages.tokensDescription}
        action={tokens.length > 0 ? newTokenButton : null}
      >
        <Panel>
          {tokensQuery.isPending ? (
            <PanelSkeleton rows={2} />
          ) : tokensQuery.isError ? (
            <PanelEmpty
              tone="error"
              icon={KeyRound}
              title={messages.unavailable}
              description={apiErrorMessage(tokensQuery.error, messages.loadFailed)}
            />
          ) : (
            <TokenRows
              tokens={tokens}
              groupsById={groupsById}
              revokingTokenId={revokingTokenId}
              onRevoke={(tokenId) => {
                setRevokingTokenId(tokenId)
                revokeToken.mutate(
                  { path: { tokenId } },
                  { onSettled: () => setRevokingTokenId(null) }
                )
              }}
              empty={
                <PanelEmpty
                  icon={KeyRound}
                  title={messages.emptyTitle}
                  description={messages.emptyDescription}
                  action={newTokenButton}
                />
              }
            />
          )}
        </Panel>
      </PageSection>

      <PageSection title={messages.cliTitle} description={messages.cliDescription}>
        <Panel>
          <PanelRow
            leading={<IconTile icon={SquareTerminal} />}
            title={
              <code className="truncate font-mono text-[0.8125rem] font-normal">
                sixb login {apiUrl}
              </code>
            }
            trailing={<CopyButton value={`sixb login ${apiUrl}`} />}
          />
        </Panel>
      </PageSection>

      <TokenFormDialog
        open={dialogOpen}
        onOpenChange={handleDialogChange}
        kind="personal"
        groups={groups ?? []}
        defaultGroupIds={allGroupIds}
        onSubmit={(body) => createToken.mutate({ body })}
        isSubmitting={createToken.isPending}
        errorMessage={
          createToken.isError ? apiErrorMessage(createToken.error, messages.createFailed) : null
        }
        created={created}
      />
    </SectionPage>
  )
}
