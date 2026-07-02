import type {
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
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  toast,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Plus,
  Power,
  Terminal,
} from "lucide-react"
import { type SubmitEvent, useEffect, useMemo, useState } from "react"
import {
  AccessErrorState,
  type AuthGroupOption,
  apiErrorMessage,
  type CreatedTokenState,
  formatDate,
  GroupPicker,
  LoadingSpinner,
  ScopeChips,
  TokenFormDialog,
  TokenList,
} from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

type ServiceAccount = ListAuthServiceAccountsResponse["serviceAccounts"][number]
type ServiceAccountToken = ListAuthServiceAccountAccessTokensResponse["accessTokens"][number]

function maskServiceId(id: string): string {
  const body = id.replace(/^svc_/, "")
  if (body.length <= 12) return id
  return `svc_${body.slice(0, 4)}…${body.slice(-4)}`
}

// A short monogram from the account name, the way GitHub/Linear render an
// identity that has no logo. Acronyms keep their leading capitals (CI, GH);
// other names take the first letter of their first two words.
function accountMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "—"
  const caps = words[0].replace(/[^A-Z]/g, "")
  if (caps.length >= 2) return caps.slice(0, 2)
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase()
}

function ServiceAccountAvatar({
  name,
  size = "sm",
}: {
  readonly name: string
  readonly size?: "sm" | "lg"
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center bg-accent font-semibold uppercase tracking-tight text-accent-foreground",
        size === "lg" ? "h-11 w-11 rounded-xl text-base" : "h-9 w-9 rounded-lg text-xs"
      )}
    >
      {accountMonogram(name)}
    </span>
  )
}

export function SettingsServiceAccountsPage() {
  const queryClient = useQueryClient()
  const [createAccountOpen, setCreateAccountOpen] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [createdToken, setCreatedToken] = useState<CreatedTokenState | null>(null)
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null)

  const optionsQuery = useQuery({ ...getAuthAccessManagementOptionsOptions(), retry: false })
  const serviceAccountsQuery = useQuery({
    ...listAuthServiceAccountsOptions(),
    enabled: optionsQuery.isSuccess,
    retry: false,
  })

  const groupOptions = optionsQuery.data?.groups ?? []
  const serviceAccounts = serviceAccountsQuery.data?.serviceAccounts ?? []
  const groupOptionsById = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group])),
    [groupOptions]
  )

  const tokenQueries = useQueries({
    queries: serviceAccounts.map((account) => ({
      ...listAuthServiceAccountAccessTokensOptions({ path: { serviceAccountId: account.id } }),
      enabled: serviceAccountsQuery.isSuccess,
      retry: false,
    })),
  })

  const tokensByAccount = useMemo(() => {
    const map = new Map<string, { tokens: readonly ServiceAccountToken[]; isLoading: boolean }>()
    serviceAccounts.forEach((account, index) => {
      const query = tokenQueries[index]
      map.set(account.id, {
        tokens: query?.data?.accessTokens ?? [],
        isLoading: query?.isLoading ?? false,
      })
    })
    return map
  }, [serviceAccounts, tokenQueries])

  const selectedAccount = useMemo(
    () => serviceAccounts.find((account) => account.id === selectedAccountId) ?? null,
    [serviceAccounts, selectedAccountId]
  )
  const selectedTokensState = selectedAccountId ? tokensByAccount.get(selectedAccountId) : undefined
  const selectedAccountGroups = useMemo<readonly AuthGroupOption[]>(() => {
    if (!selectedAccount) return []
    return selectedAccount.groupIds.map((id) => groupOptionsById.get(id) ?? { id })
  }, [selectedAccount, groupOptionsById])

  const invalidateAccountTokens = (serviceAccountId: string) =>
    queryClient.invalidateQueries({
      queryKey: listAuthServiceAccountAccessTokensQueryKey({ path: { serviceAccountId } }),
    })

  const createAccount = useMutation({
    ...createAuthServiceAccountMutation(),
    onSuccess: async () => {
      setCreateAccountOpen(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getAuthAccessManagementOptionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listAuthServiceAccountsQueryKey() }),
      ])
    },
  })

  const disableAccount = useMutation({
    ...disableAuthServiceAccountMutation(),
    onSuccess: async () => {
      toast.success("Service account disabled.")
      await queryClient.invalidateQueries({ queryKey: listAuthServiceAccountsQueryKey() })
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not disable the service account."))
    },
  })

  const createToken = useMutation({
    ...createAuthServiceAccountAccessTokenMutation(),
    onSuccess: async (result) => {
      setCreatedToken({ tokenValue: result.tokenValue, name: result.accessToken.name })
      if (selectedAccountId) await invalidateAccountTokens(selectedAccountId)
    },
  })

  const revokeToken = useMutation({
    ...revokeAuthServiceAccountAccessTokenMutation(),
    onSuccess: async () => {
      toast.success("Token revoked.")
      if (selectedAccountId) await invalidateAccountTokens(selectedAccountId)
    },
    onError: (mutationError) => {
      toast.error(apiErrorMessage(mutationError, "Could not revoke the token."))
    },
  })

  const handleTokenDialogChange = (open: boolean) => {
    setTokenDialogOpen(open)
    if (open) {
      createToken.reset()
      setCreatedToken(null)
    } else {
      // Clear the revealed secret once the dialog has closed, but only after
      // the exit animation so the form never flashes back into view.
      window.setTimeout(() => setCreatedToken(null), 200)
    }
  }

  const closeSheet = () => {
    setSelectedAccountId(null)
    setTokenDialogOpen(false)
    setCreatedToken(null)
  }

  const openAccount = (accountId: string) => {
    setSelectedAccountId(accountId)
  }

  const revoke = (tokenId: string) => {
    if (!selectedAccountId) return
    setRevokingTokenId(tokenId)
    revokeToken.mutate(
      { path: { serviceAccountId: selectedAccountId, tokenId } },
      { onSettled: () => setRevokingTokenId(null) }
    )
  }

  if (optionsQuery.isLoading) {
    return (
      <div className="flex min-h-90 items-center justify-center">
        <LoadingSpinner text="Loading service-account settings…" />
      </div>
    )
  }

  if (optionsQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <SettingsTabs />
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
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <SettingsTabs />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            Service accounts
          </h1>
          <p className="mt-1.5 max-w-[56ch] text-sm text-muted-foreground">
            Standalone identities for CI, agents, and automation. Each carries its own tokens and
            scopes, independent of any person.
          </p>
        </div>
        <Button type="button" className="shrink-0" onClick={() => setCreateAccountOpen(true)}>
          <Plus className="h-4 w-4" />
          New service account
        </Button>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-baseline justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Accounts</h2>
          <span className="text-xs text-muted-foreground">
            {serviceAccounts.length} {serviceAccounts.length === 1 ? "account" : "accounts"}
          </span>
        </div>

        {serviceAccountsQuery.isLoading ? (
          <div className="flex min-h-50 items-center justify-center">
            <LoadingSpinner text="Loading service accounts…" />
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
            icon={<Terminal className="h-9 w-9" />}
            title="No service accounts yet"
            description="Create one to give CI or an agent its own identity and tokens."
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {serviceAccounts.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  onClick={() => openAccount(account.id)}
                  className="group flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30"
                >
                  <ServiceAccountAvatar name={account.name} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {account.name}
                      </span>
                      <AccountStatusBadge status={account.status} />
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span className="font-mono">{maskServiceId(account.id)}</span>
                      <span className="text-muted-foreground/50">·</span>
                      <span>{tokenCountLabel(tokensByAccount.get(account.id))}</span>
                      {account.description ? (
                        <>
                          <span className="text-muted-foreground/50">·</span>
                          <span className="truncate">{account.description}</span>
                        </>
                      ) : null}
                    </span>
                  </span>
                  <ChevronRight className="h-4.5 w-4.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Detail slide-over */}
      <Sheet open={selectedAccount !== null} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-136">
          {selectedAccount ? (
            <>
              <div className="border-b border-border/60 p-5 pr-12">
                <AccountStatusBadge status={selectedAccount.status} />
                <div className="mt-3.5 flex items-start gap-3">
                  <ServiceAccountAvatar name={selectedAccount.name} size="lg" />
                  <div className="min-w-0 flex-1">
                    <SheetTitle className="truncate text-lg">{selectedAccount.name}</SheetTitle>
                    <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                      <span className="truncate">{selectedAccount.id}</span>
                      <CopyButton value={selectedAccount.id} label="Copy identifier" />
                    </div>
                  </div>
                </div>
                <SheetDescription className="mt-3.5">
                  {selectedAccount.description || "No description."}
                </SheetDescription>
                <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3.5">
                  <div className="min-w-0">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Scopes
                    </dt>
                    <dd className="mt-1.5">
                      <ScopeChips
                        groupIds={selectedAccount.groupIds}
                        groupOptionsById={groupOptionsById}
                      />
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Created
                    </dt>
                    <dd className="mt-1.5 text-sm text-foreground">
                      {formatDate(selectedAccount.createdAt)}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="flex-1 overflow-auto p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Tokens</h3>
                  <Button
                    type="button"
                    size="sm"
                    disabled={selectedAccount.status !== "active"}
                    onClick={() => handleTokenDialogChange(true)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New token
                  </Button>
                </div>

                {selectedAccount.status !== "active" ? (
                  <p className="mb-3 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                    This account is disabled. Its tokens are blocked and it can't mint new ones.
                  </p>
                ) : null}

                <div className="overflow-hidden rounded-xl border border-border/60">
                  {selectedTokensState?.isLoading ? (
                    <div className="flex min-h-40 items-center justify-center">
                      <LoadingSpinner text="Loading tokens…" />
                    </div>
                  ) : (
                    <TokenList
                      tokens={selectedTokensState?.tokens ?? []}
                      groupOptionsById={groupOptionsById}
                      revokingTokenId={revokingTokenId}
                      onRevoke={revoke}
                      emptyTitle="No tokens yet"
                      emptyDescription="Mint a token to let this account authenticate."
                    />
                  )}
                </div>

                {selectedAccount.status === "active" ? (
                  <div className="mt-6 flex items-center justify-between gap-3 border-t border-border/60 pt-5">
                    <p className="max-w-[34ch] text-xs text-muted-foreground">
                      Disabling blocks every token for this account immediately and can't be undone.
                    </p>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={disableAccount.isPending}
                        >
                          {disableAccount.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Power className="h-3.5 w-3.5" />
                          )}
                          Disable account
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Disable {selectedAccount.name}?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Every token for this account stops working immediately. This can't be
                            undone — you'll need to create a new account to restore access.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="bg-destructive text-white hover:bg-destructive/90"
                            onClick={() =>
                              disableAccount.mutate({
                                path: { serviceAccountId: selectedAccount.id },
                              })
                            }
                          >
                            Disable account
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* Create service account */}
      <ServiceAccountFormDialog
        open={createAccountOpen}
        onOpenChange={(open) => {
          setCreateAccountOpen(open)
          createAccount.reset()
        }}
        groups={groupOptions}
        onSubmit={(body) => createAccount.mutate({ body })}
        isSubmitting={createAccount.isPending}
        errorMessage={
          createAccount.isError
            ? apiErrorMessage(createAccount.error, "Could not create the service account.")
            : null
        }
      />

      {/* Create service-account token (launched from the sheet) */}
      <TokenFormDialog
        open={tokenDialogOpen}
        onOpenChange={handleTokenDialogChange}
        kind="service"
        groups={selectedAccountGroups}
        defaultGroupIds={selectedAccount?.groupIds ?? []}
        onSubmit={(body) => {
          if (!selectedAccountId) return
          createToken.mutate({ path: { serviceAccountId: selectedAccountId }, body })
        }}
        isSubmitting={createToken.isPending}
        errorMessage={
          createToken.isError
            ? apiErrorMessage(createToken.error, "Could not create the service-account token.")
            : null
        }
        created={createdToken}
        disabled={selectedAccount?.status !== "active"}
      />
    </div>
  )
}

function tokenCountLabel(
  state: { readonly tokens: readonly unknown[]; readonly isLoading: boolean } | undefined
): string {
  if (!state || state.isLoading) return "…"
  const count = state.tokens.length
  return `${count} ${count === 1 ? "token" : "tokens"}`
}

function AccountStatusBadge({ status }: { readonly status: ServiceAccount["status"] }) {
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Active
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="rounded-full border-border/60 bg-muted text-muted-foreground"
    >
      Disabled
    </Badge>
  )
}

function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch {
          setCopied(false)
        }
      }}
      className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  )
}

function ServiceAccountFormDialog({
  open,
  onOpenChange,
  groups,
  onSubmit,
  isSubmitting,
  errorMessage,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly groups: readonly AuthGroupOption[]
  readonly onSubmit: (body: {
    id?: string
    name: string
    description?: string
    groupIds: string[]
  }) => void
  readonly isSubmitting: boolean
  readonly errorMessage: string | null
}) {
  const [name, setName] = useState("")
  const [customId, setCustomId] = useState("")
  const [description, setDescription] = useState("")
  const [selectedGroupIds, setSelectedGroupIds] = useState<readonly string[]>([])

  useEffect(() => {
    if (!open) return
    setName("")
    setCustomId("")
    setDescription("")
    setSelectedGroupIds([])
  }, [open])

  const canSubmit = name.trim().length > 0 && !isSubmitting

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return
    const id = customId.trim()
    const trimmedDescription = description.trim()
    onSubmit({
      ...(id ? { id } : {}),
      name: name.trim(),
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
      groupIds: [...selectedGroupIds],
    })
  }

  const inputClass =
    "h-10 w-full rounded-lg border border-border/60 bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader className="space-y-1.5 p-5 pb-0 text-left">
            <DialogTitle className="text-base">New service account</DialogTitle>
            <DialogDescription>
              A standalone identity for automation. You can mint tokens for it after it's created.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 p-5">
            <div className="space-y-2">
              <label htmlFor="sa-name" className="block text-xs font-medium text-foreground">
                Name
              </label>
              <input
                id="sa-name"
                type="text"
                value={name}
                autoComplete="off"
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder="Deployment agent"
                className={inputClass}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="sa-id" className="block text-xs font-medium text-foreground">
                Identifier <span className="font-normal text-muted-foreground">— optional</span>
              </label>
              <input
                id="sa-id"
                type="text"
                value={customId}
                autoComplete="off"
                onChange={(event) => setCustomId(event.target.value)}
                placeholder="svc_deploy"
                className={cn(inputClass, "font-mono text-xs")}
              />
              <p className="text-xs text-muted-foreground">
                Generated automatically if left blank.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="sa-desc" className="block text-xs font-medium text-foreground">
                Description
              </label>
              <input
                id="sa-desc"
                type="text"
                value={description}
                autoComplete="off"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Used by CI and sandboxed agents"
                className={inputClass}
              />
            </div>

            <div className="space-y-2">
              <span className="block text-xs font-medium text-foreground">Scopes</span>
              <p className="-mt-0.5 text-xs text-muted-foreground">
                Bounded by your own access. Tokens minted for this account can't exceed it.
              </p>
              <GroupPicker
                groups={groups}
                selectedGroupIds={selectedGroupIds}
                onChange={setSelectedGroupIds}
                disabled={isSubmitting}
              />
            </div>

            {errorMessage && (
              <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                {errorMessage}
              </p>
            )}
          </div>

          <DialogFooter className="border-t border-border/60 bg-muted/30 p-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Terminal className="h-4 w-4" />
              )}
              Create account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
