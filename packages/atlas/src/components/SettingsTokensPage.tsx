import {
  createAuthPersonalAccessTokenMutation,
  getAuthAccessManagementOptionsOptions,
  getAuthAccessManagementOptionsQueryKey,
  listAuthAccessTokensOptions,
  listAuthAccessTokensQueryKey,
  revokeAuthAccessTokenMutation,
} from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RefreshCw, Search } from "lucide-react"
import { useMemo, useState } from "react"
import {
  AccessErrorState,
  apiErrorMessage,
  type CreatedTokenState,
  LoadingSpinner,
  TokenFormDialog,
  TokenList,
} from "./SettingsAccessControls"
import { SettingsTabs } from "./SettingsTabs"

type StatusFilter = "all" | "active" | "inactive"

const STATUS_FILTERS: readonly { readonly id: StatusFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "inactive", label: "Inactive" },
]

export function SettingsTokensPage() {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [created, setCreated] = useState<CreatedTokenState | null>(null)
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const optionsQuery = useQuery({ ...getAuthAccessManagementOptionsOptions(), retry: false })
  const tokensQuery = useQuery({
    ...listAuthAccessTokensOptions(),
    enabled: optionsQuery.isSuccess,
    retry: false,
  })

  const groupOptions = optionsQuery.data?.groups ?? []
  const tokens = tokensQuery.data?.accessTokens ?? []
  const groupOptionsById = useMemo(
    () => new Map(groupOptions.map((group) => [group.id, group])),
    [groupOptions]
  )
  const allGroupIds = useMemo(() => groupOptions.map((group) => group.id), [groupOptions])

  const filteredTokens = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return tokens.filter((token) => {
      if (needle && !token.name.toLowerCase().includes(needle) && !token.id.includes(needle)) {
        return false
      }
      if (statusFilter === "active") return token.status === "active"
      if (statusFilter === "inactive") return token.status !== "active"
      return true
    })
  }, [tokens, query, statusFilter])

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
      setError(null)
      setMessage("Token revoked.")
      await refresh()
    },
    onError: (mutationError) => {
      setMessage(null)
      setError(apiErrorMessage(mutationError, "Could not revoke the token."))
    },
  })

  const handleDialogChange = (open: boolean) => {
    setDialogOpen(open)
    if (open) {
      createToken.reset()
      setCreated(null)
    } else {
      // Clear the revealed secret once the dialog has closed, but only after
      // the exit animation so the form never flashes back into view.
      window.setTimeout(() => setCreated(null), 200)
    }
  }

  const revoke = (tokenId: string) => {
    setMessage(null)
    setError(null)
    setRevokingTokenId(tokenId)
    revokeToken.mutate({ path: { tokenId } }, { onSettled: () => setRevokingTokenId(null) })
  }

  if (optionsQuery.isLoading) {
    return (
      <div className="flex min-h-90 items-center justify-center">
        <LoadingSpinner text="Loading token settings…" />
      </div>
    )
  }

  if (optionsQuery.isError) {
    return (
      <div className="space-y-4">
        <SettingsTabs />
        <AccessErrorState
          title="Token settings unavailable"
          description={apiErrorMessage(optionsQuery.error, "Could not load token settings.")}
        />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <SettingsTabs />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
            Personal access tokens
          </h1>
          <p className="mt-1.5 max-w-[52ch] text-sm text-muted-foreground">
            Tokens authenticate the CLI and API as you, with at most your own access. Treat them
            like passwords.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              tokensQuery.refetch()
              optionsQuery.refetch()
            }}
            title="Refresh"
          >
            <RefreshCw className={cn("h-4 w-4", tokensQuery.isFetching && "animate-spin")} />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button type="button" onClick={() => handleDialogChange(true)}>
            <Plus className="h-4 w-4" />
            New token
          </Button>
        </div>
      </div>

      {tokens.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tokens"
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

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
        <div className="flex items-baseline justify-between border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">Your tokens</h2>
          <span className="text-xs text-muted-foreground">
            {tokens.length} {tokens.length === 1 ? "token" : "tokens"}
          </span>
        </div>

        {(message || error) && (
          <p
            className={cn(
              "mx-4 mt-4 rounded-lg px-3 py-2 text-sm",
              error
                ? "border border-destructive/30 bg-destructive/10 text-destructive"
                : "border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
            )}
          >
            {error ?? message}
          </p>
        )}

        {tokensQuery.isLoading ? (
          <div className="flex min-h-50 items-center justify-center">
            <LoadingSpinner text="Loading tokens…" />
          </div>
        ) : tokensQuery.isError ? (
          <AccessErrorState
            title="Tokens unavailable"
            description={apiErrorMessage(tokensQuery.error, "Could not load tokens.")}
          />
        ) : (
          <TokenList
            tokens={filteredTokens}
            groupOptionsById={groupOptionsById}
            revokingTokenId={revokingTokenId}
            onRevoke={revoke}
            emptyTitle={tokens.length === 0 ? "No tokens yet" : "No matching tokens"}
            emptyDescription={
              tokens.length === 0
                ? "Create a token to authenticate the CLI and API as you."
                : "Try a different search or status filter."
            }
          />
        )}
      </section>

      <TokenFormDialog
        open={dialogOpen}
        onOpenChange={handleDialogChange}
        kind="personal"
        groups={groupOptions}
        defaultGroupIds={allGroupIds}
        onSubmit={(body) => createToken.mutate({ body })}
        isSubmitting={createToken.isPending}
        errorMessage={
          createToken.isError
            ? apiErrorMessage(createToken.error, "Could not create the token.")
            : null
        }
        created={created}
      />
    </div>
  )
}
