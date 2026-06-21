import type {
  CreateAuthServiceAccountAccessTokenResponse,
  ListAuthServiceAccountAccessTokensResponse,
  ListAuthServiceAccountsResponse,
} from "@sixb/client"
import {
  createAuthServiceAccountAccessTokenMutation,
  createAuthServiceAccountMutation,
  disableAuthServiceAccountMutation,
  getAuthAccessManagementOptionsOptions,
  getAuthAccessManagementOptionsQueryKey,
  listAuthServiceAccountAccessTokensOptions,
  listAuthServiceAccountAccessTokensQueryKey,
  listAuthServiceAccountsOptions,
  listAuthServiceAccountsQueryKey,
  revokeAuthServiceAccountAccessTokenMutation,
} from "@sixb/client/hooks"
import { Badge, EmptyState } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, KeyRound, Power, RefreshCw, Shield } from "lucide-react"
import { type FormEvent, useEffect, useMemo, useState } from "react"
import {
  AccessErrorState,
  AccessTokensTable,
  apiErrorMessage,
  dateInputToIso,
  defaultExpiresOn,
  ExpirationPicker,
  GroupBadges,
  GroupPicker,
  LoadingSpinner,
  TokenReveal,
} from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

type ServiceAccount = ListAuthServiceAccountsResponse["serviceAccounts"][number]
type ServiceAccountToken = ListAuthServiceAccountAccessTokensResponse["accessTokens"][number]
type ServiceAccountTokenCreateResult = CreateAuthServiceAccountAccessTokenResponse

export function SettingsServiceAccountsPage() {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [customId, setCustomId] = useState("")
  const [description, setDescription] = useState("")
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [disablingServiceAccountId, setDisablingServiceAccountId] = useState<string | null>(null)

  const optionsQuery = useQuery({
    ...getAuthAccessManagementOptionsOptions(),
    retry: false,
  })
  const serviceAccountsQuery = useQuery({
    ...listAuthServiceAccountsOptions(),
    enabled: optionsQuery.isSuccess,
    retry: false,
  })

  const groupOptions = optionsQuery.data?.groups ?? []
  const serviceAccounts = serviceAccountsQuery.data?.serviceAccounts ?? []
  const canSubmit = name.trim().length > 0
  const groupOptionsById = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group])),
    [groupOptions]
  )

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getAuthAccessManagementOptionsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: listAuthServiceAccountsQueryKey() }),
    ])
  }

  const createServiceAccount = useMutation({
    ...createAuthServiceAccountMutation(),
    onSuccess: async () => {
      setName("")
      setCustomId("")
      setDescription("")
      setSelectedGroupIds([])
      setMessage("Service account created.")
      setFormError(null)
      await refresh()
    },
    onError: (error) => {
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not create the service account."))
    },
  })

  const disableServiceAccount = useMutation({
    ...disableAuthServiceAccountMutation(),
    onSuccess: async () => {
      setMessage("Service account disabled.")
      setFormError(null)
      await refresh()
    },
    onError: (error) => {
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not disable the service account."))
    },
  })

  const submitServiceAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(null)
    setFormError(null)

    if (!canSubmit || createServiceAccount.isPending) {
      return
    }

    const id = customId.trim()
    const trimmedDescription = description.trim()
    createServiceAccount.mutate({
      body: {
        ...(id ? { id } : {}),
        name: name.trim(),
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
        groupIds: selectedGroupIds,
      },
    })
  }

  const disableAccount = (serviceAccountId: ServiceAccount["id"]) => {
    setMessage(null)
    setFormError(null)
    setDisablingServiceAccountId(serviceAccountId)
    disableServiceAccount.mutate(
      { path: { serviceAccountId } },
      { onSettled: () => setDisablingServiceAccountId(null) }
    )
  }

  if (optionsQuery.isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <LoadingSpinner text="Loading service-account settings..." />
      </div>
    )
  }

  if (optionsQuery.isError) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <AccessErrorState
          title="Service-account settings unavailable"
          description={apiErrorMessage(
            optionsQuery.error,
            "Could not load service-account settings."
          )}
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
            Service accounts
          </h1>
        </div>
        <button
          type="button"
          onClick={() => {
            serviceAccountsQuery.refetch()
            optionsQuery.refetch()
          }}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border/60 bg-card px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <section className="rounded-xl border border-border/60 bg-card">
        <form onSubmit={submitServiceAccount} className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">Create service account</h2>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]">
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
                placeholder="Deployment agent"
                className="h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </label>

            <label className="min-w-0">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Optional ID
              </span>
              <input
                type="text"
                value={customId}
                onChange={(event) => {
                  setCustomId(event.target.value)
                  setMessage(null)
                  setFormError(null)
                }}
                placeholder="svc_deploy"
                className="h-10 w-full rounded-lg border border-border/60 bg-background px-3 font-mono text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </label>
          </div>

          <label className="block min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Description
            </span>
            <input
              type="text"
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
                setMessage(null)
                setFormError(null)
              }}
              placeholder="Used by CI and sandboxed agents"
              className="h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/60"
            />
          </label>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Groups</p>
              <GroupPicker
                groups={groupOptions}
                selectedGroupIds={selectedGroupIds}
                onChange={(nextGroupIds) => {
                  setSelectedGroupIds(nextGroupIds)
                  setMessage(null)
                  setFormError(null)
                }}
                disabled={createServiceAccount.isPending}
              />
            </div>
            <button
              type="submit"
              disabled={!canSubmit || createServiceAccount.isPending}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createServiceAccount.isPending ? (
                <LoadingSpinner size="sm" className="text-primary-foreground" />
              ) : (
                <Bot className="h-4 w-4" />
              )}
              Create service account
            </button>
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
            <h2 className="text-sm font-semibold text-foreground">Service accounts</h2>
            <p className="mt-1 text-xs text-muted-foreground">{serviceAccounts.length} visible</p>
          </div>
        </div>

        {serviceAccountsQuery.isLoading ? (
          <div className="flex min-h-[220px] items-center justify-center">
            <LoadingSpinner text="Loading service accounts..." />
          </div>
        ) : serviceAccountsQuery.isError ? (
          <AccessErrorState
            title="Service accounts unavailable"
            description={apiErrorMessage(
              serviceAccountsQuery.error,
              "Could not load service accounts."
            )}
          />
        ) : serviceAccounts.length === 0 ? (
          <EmptyState
            icon={<Bot className="h-10 w-10" />}
            title="No service accounts"
            description="Service accounts created here will appear in this list."
          />
        ) : (
          <div className="divide-y divide-border/50">
            {serviceAccounts.map((serviceAccount) => (
              <article key={serviceAccount.id} className="p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">
                        {serviceAccount.name}
                      </h3>
                      <ServiceAccountStatusBadge status={serviceAccount.status} />
                    </div>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {serviceAccount.id}
                    </p>
                    {serviceAccount.description && (
                      <p className="mt-2 text-sm text-muted-foreground">
                        {serviceAccount.description}
                      </p>
                    )}
                    <div className="mt-3">
                      <GroupBadges
                        groupIds={serviceAccount.groupIds}
                        groupOptionsById={groupOptionsById}
                      />
                    </div>
                  </div>

                  {serviceAccount.status === "active" ? (
                    <button
                      type="button"
                      onClick={() => disableAccount(serviceAccount.id)}
                      disabled={disablingServiceAccountId === serviceAccount.id}
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-lg border border-destructive/30 bg-destructive/10 px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {disablingServiceAccountId === serviceAccount.id ? (
                        <LoadingSpinner size="sm" />
                      ) : (
                        <Power className="h-4 w-4" />
                      )}
                      Disable
                    </button>
                  ) : null}
                </div>

                <ServiceAccountTokenPanel
                  serviceAccount={serviceAccount}
                  groupOptionsById={groupOptionsById}
                />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ServiceAccountStatusBadge({ status }: { readonly status: ServiceAccount["status"] }) {
  const active = status === "active"
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-md",
        active
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-muted-foreground/20 bg-muted text-muted-foreground"
      )}
    >
      {active ? "Active" : "Disabled"}
    </Badge>
  )
}

function ServiceAccountTokenPanel({
  serviceAccount,
  groupOptionsById,
}: {
  readonly serviceAccount: ServiceAccount
  readonly groupOptionsById: ReadonlyMap<
    string,
    { readonly id: string; readonly label?: string; readonly description?: string }
  >
}) {
  const queryClient = useQueryClient()
  const tokenListOptions = { path: { serviceAccountId: serviceAccount.id } }
  const [tokenName, setTokenName] = useState("")
  const [expiresOn, setExpiresOn] = useState(defaultExpiresOn())
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>(serviceAccount.groupIds)
  const [createdToken, setCreatedToken] = useState<ServiceAccountTokenCreateResult | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null)

  const tokensQuery = useQuery({
    ...listAuthServiceAccountAccessTokensOptions(tokenListOptions),
    retry: false,
  })
  const accountGroupOptions = useMemo(
    () =>
      serviceAccount.groupIds.map((groupId) => groupOptionsById.get(groupId) ?? { id: groupId }),
    [groupOptionsById, serviceAccount.groupIds]
  )
  const disabled = serviceAccount.status !== "active"
  const canSubmit = !disabled && tokenName.trim().length > 0 && expiresOn.length > 0
  const tokens = tokensQuery.data?.accessTokens ?? []

  useEffect(() => {
    setSelectedGroupIds(serviceAccount.groupIds)
  }, [serviceAccount.groupIds])

  const refreshTokens = () =>
    queryClient.invalidateQueries({
      queryKey: listAuthServiceAccountAccessTokensQueryKey(tokenListOptions),
    })

  const createToken = useMutation({
    ...createAuthServiceAccountAccessTokenMutation(),
    onSuccess: async (result) => {
      setCreatedToken(result)
      setTokenName("")
      setExpiresOn(defaultExpiresOn())
      setMessage("Token created.")
      setFormError(null)
      await refreshTokens()
    },
    onError: (error) => {
      setCreatedToken(null)
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not create the service-account token."))
    },
  })

  const revokeToken = useMutation({
    ...revokeAuthServiceAccountAccessTokenMutation(),
    onSuccess: async () => {
      setMessage("Token revoked.")
      setFormError(null)
      await refreshTokens()
    },
    onError: (error) => {
      setMessage(null)
      setFormError(apiErrorMessage(error, "Could not revoke the service-account token."))
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
        path: { serviceAccountId: serviceAccount.id },
        body: {
          name: tokenName.trim(),
          expiresAt: dateInputToIso(expiresOn),
          groupIds: selectedGroupIds,
        },
      })
    } catch {
      setFormError("Choose a valid expiration date.")
    }
  }

  const revoke = (tokenId: ServiceAccountToken["id"]) => {
    setMessage(null)
    setFormError(null)
    setRevokingTokenId(tokenId)
    revokeToken.mutate(
      { path: { serviceAccountId: serviceAccount.id, tokenId } },
      { onSettled: () => setRevokingTokenId(null) }
    )
  }

  return (
    <div className="mt-4 border-t border-border/50 pt-4">
      <form onSubmit={submitToken} className="space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-sm font-semibold text-foreground">Service-account tokens</h4>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <label className="min-w-0">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Token name
            </span>
            <input
              type="text"
              value={tokenName}
              onChange={(event) => {
                setTokenName(event.target.value)
                setMessage(null)
                setFormError(null)
              }}
              disabled={disabled}
              placeholder="Sandbox agent"
              className="h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50"
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
              <Shield className="h-4 w-4" />
            )}
            Create token
          </button>
        </div>

        <label className="block min-w-0">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Expires</span>
          <ExpirationPicker
            value={expiresOn}
            disabled={disabled}
            onChange={(nextValue) => {
              setExpiresOn(nextValue)
              setMessage(null)
              setFormError(null)
            }}
          />
        </label>

        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Token groups</p>
          <GroupPicker
            groups={accountGroupOptions}
            selectedGroupIds={selectedGroupIds}
            onChange={(nextGroupIds) => {
              setSelectedGroupIds(nextGroupIds)
              setMessage(null)
              setFormError(null)
            }}
            disabled={disabled || createToken.isPending}
          />
        </div>

        {createdToken && (
          <TokenReveal label="Service-account token ready" tokenValue={createdToken.tokenValue} />
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

      <div className="mt-4 rounded-lg border border-border/50">
        {tokensQuery.isLoading ? (
          <div className="flex min-h-[180px] items-center justify-center">
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
      </div>
    </div>
  )
}
