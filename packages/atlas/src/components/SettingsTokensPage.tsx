import type {
  CreateAuthPersonalAccessTokenResponse,
  ListAuthAccessTokensResponse,
} from "@sixb/client"
import {
  createAuthPersonalAccessTokenMutation,
  getAuthAccessManagementOptionsOptions,
  getAuthAccessManagementOptionsQueryKey,
  listAuthAccessTokensOptions,
  listAuthAccessTokensQueryKey,
  revokeAuthAccessTokenMutation,
} from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { KeyRound, RefreshCw } from "lucide-react"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import {
  AccessErrorState,
  AccessTokensTable,
  apiErrorMessage,
  dateInputToIso,
  defaultExpiresOn,
  ExpirationPicker,
  GroupPicker,
  LoadingSpinner,
  TokenReveal,
} from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

type AccessToken = ListAuthAccessTokensResponse["accessTokens"][number]

export function SettingsTokensPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [expiresOn, setExpiresOn] = useState(defaultExpiresOn())
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [groupsInitialized, setGroupsInitialized] = useState(false)
  const [createdToken, setCreatedToken] = useState<CreateAuthPersonalAccessTokenResponse | null>(
    null
  )
  const [message, setMessage] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null)

  const optionsQuery = useQuery({
    ...getAuthAccessManagementOptionsOptions(),
    retry: false,
  })
  const tokensQuery = useQuery({
    ...listAuthAccessTokensOptions(),
    enabled: optionsQuery.isSuccess,
    retry: false,
  })

  const groupOptions = optionsQuery.data?.groups ?? []
  const tokens = tokensQuery.data?.accessTokens ?? []
  const canSubmit = name.trim().length > 0 && expiresOn.length > 0
  const groupOptionsById = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group])),
    [groupOptions]
  )

  useEffect(() => {
    if (groupsInitialized || !optionsQuery.data) return
    setSelectedGroupIds(optionsQuery.data.groups.map((group) => group.id))
    setGroupsInitialized(true)
  }, [groupsInitialized, optionsQuery.data])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthAccessManagementOptionsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listAuthAccessTokensQueryKey() }),
    ])
  }

  const createToken = useMutation({
    ...createAuthPersonalAccessTokenMutation(),
    onSuccess: async (result) => {
      setCreatedToken(result)
      setName("")
      setExpiresOn(defaultExpiresOn())
      setMessage("Token created.")
      setFormError(null)
      await refresh()
    },
    onError: (error) => {
      setCreatedToken(null)
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not create the token."))
    },
  })

  const revokeToken = useMutation({
    ...revokeAuthAccessTokenMutation(),
    onSuccess: async () => {
      setMessage("Token revoked.")
      setFormError(null)
      await refresh()
    },
    onError: (error) => {
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not revoke the token."))
    },
  })

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(null)
    setFormError(null)

    if (!canSubmit || createToken.isPending) {
      return
    }

    try {
      createToken.mutate({
        body: {
          name: name.trim(),
          expiresAt: dateInputToIso(expiresOn),
          groupIds: selectedGroupIds,
        },
      })
    } catch {
      setFormError("Choose a valid expiration date.")
    }
  }

  const revoke = (tokenId: AccessToken["id"]) => {
    setMessage(null)
    setFormError(null)
    setRevokingTokenId(tokenId)
    revokeToken.mutate({ path: { tokenId } }, { onSettled: () => setRevokingTokenId(null) })
  }

  if (optionsQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <LoadingSpinner text="Loading token settings..." />
      </div>
    )
  }

  if (optionsQuery.isError) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <AccessErrorState
          title="Token settings unavailable"
          description={apiErrorMessage(optionsQuery.error, "Could not load token settings.")}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SettingsTabs />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-normal text-foreground">
            Personal access tokens
          </h1>
        </div>
        <button
          type="button"
          onClick={() => {
            tokensQuery.refetch()
            optionsQuery.refetch()
          }}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <section className="rounded-xl border border-border/60 bg-card">
        <form onSubmit={submitToken} className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <KeyRound className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                Create personal access token
              </h2>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <label className="min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Name</span>
              <input
                type="text"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  setMessage(null)
                  setFormError(null)
                }}
                placeholder="Local CLI"
                className="h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </label>

            <button
              type="submit"
              disabled={!canSubmit || createToken.isPending}
              className="inline-flex h-10 items-center justify-center gap-2 self-end rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createToken.isPending ? (
                <LoadingSpinner size="sm" className="text-primary-foreground" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              Create token
            </button>
          </div>

          <label className="block min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Expires</span>
            <ExpirationPicker
              value={expiresOn}
              onChange={(nextValue) => {
                setExpiresOn(nextValue)
                setMessage(null)
                setFormError(null)
              }}
            />
          </label>

          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Groups</p>
            <GroupPicker
              groups={groupOptions}
              selectedGroupIds={selectedGroupIds}
              onChange={(nextGroupIds) => {
                setSelectedGroupIds(nextGroupIds)
                setMessage(null)
                setFormError(null)
              }}
              disabled={createToken.isPending}
            />
          </div>

          {createdToken && (
            <TokenReveal label="Personal access token ready" tokenValue={createdToken.tokenValue} />
          )}

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
            <h2 className="text-sm font-semibold text-foreground">Personal access tokens</h2>
            <p className="mt-1 text-xs text-muted-foreground">{tokens.length} visible</p>
          </div>
        </div>

        {tokensQuery.isLoading ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <LoadingSpinner text="Loading tokens..." />
          </div>
        ) : tokensQuery.isError ? (
          <AccessErrorState
            title="Tokens unavailable"
            description={apiErrorMessage(tokensQuery.error, "Could not load tokens.")}
          />
        ) : (
          <AccessTokensTable
            tokens={tokens}
            groupOptionsById={groupOptionsById}
            revokingTokenId={revokingTokenId}
            onRevoke={revoke}
          />
        )}
      </section>
    </div>
  )
}
