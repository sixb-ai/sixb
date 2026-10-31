import type { ListAuthServiceAccountAccessTokensResponse } from "@sixb/client"
import {
  createAuthServiceAccountAccessTokenMutation,
  createAuthServiceAccountMutation,
  disableAuthServiceAccountMutation,
  getAuthMembershipOptionsOptions,
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
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@sixb/ui/components"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Check, ChevronRight, Copy, KeyRound, Loader2, Lock, Plus, Power } from "lucide-react"
import { type SubmitEvent, useEffect, useMemo, useState } from "react"
import { notify } from "../section-page"
import {
  apiErrorMessage,
  Field,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  useFormat,
} from "../section-ui"
import {
  type AuthGroupOption,
  type CreatedTokenState,
  FormError,
  GroupChips,
  GroupPicker,
  maskId,
  TokenFormDialog,
  TokenRows,
} from "./controls"
import { useSettingsMessages } from "./messages"

type ServiceAccountToken = ListAuthServiceAccountAccessTokensResponse["accessTokens"][number]

// A monogram from the account's name, the way an identity without a logo is usually drawn.
// Acronyms keep their capitals (CI, GH); other names take the first letter of two words.
function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]
  if (!first) return "—"
  const capitals = first.replace(/[^A-Z]/g, "")
  if (capitals.length >= 2) return capitals.slice(0, 2)
  return (first[0] + (words[1]?.[0] ?? "")).toUpperCase()
}

function AccountMark({
  name,
  size = "md",
}: {
  readonly name: string
  readonly size?: "md" | "lg"
}) {
  return (
    <span
      aria-hidden
      className={
        size === "lg"
          ? "flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-background text-base font-semibold text-foreground/75 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]"
          : "flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-[0.75rem] font-semibold text-foreground/75 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]"
      }
    >
      {monogram(name)}
    </span>
  )
}

/**
 * Settings › Members › Service accounts: identities for automation, managed under a membership
 * policy. The page around it owns the button that creates one.
 */
export function ServiceAccountsTab({
  createOpen,
  onCreateOpenChange: setCreateOpen,
}: {
  readonly createOpen: boolean
  readonly onCreateOpenChange: (open: boolean) => void
}) {
  const allMessages = useSettingsMessages()
  const messages = allMessages.serviceAccounts
  const queryClient = useQueryClient()
  const format = useFormat()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [createdToken, setCreatedToken] = useState<CreatedTokenState | null>(null)
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null)

  const optionsQuery = useQuery({ ...getAuthMembershipOptionsOptions(), retry: false })
  const accountsQuery = useQuery({ ...listAuthServiceAccountsOptions(), retry: false })
  const canManage = optionsQuery.data?.capabilities.serviceAccounts === true
  const groups = optionsQuery.data?.serviceAccountGroups
  // Active accounts first.
  const accounts = [...(accountsQuery.data?.serviceAccounts ?? [])].sort(
    (left, right) => Number(left.status !== "active") - Number(right.status !== "active")
  )
  const groupsById = useMemo(
    () => new Map<string, AuthGroupOption>((groups ?? []).map((g) => [g.id, g])),
    [groups]
  )

  const tokenQueries = useQueries({
    queries: accounts.map((account) => ({
      ...listAuthServiceAccountAccessTokensOptions({ path: { serviceAccountId: account.id } }),
      retry: false,
    })),
  })
  const tokensByAccount = new Map<
    string,
    { tokens: readonly ServiceAccountToken[]; loading: boolean }
  >(
    accounts.map((account, index) => [
      account.id,
      {
        tokens: tokenQueries[index]?.data?.accessTokens ?? [],
        loading: tokenQueries[index]?.isPending ?? true,
      },
    ])
  )

  const selected = accounts.find((account) => account.id === selectedId) ?? null
  const selectedTokens = selected ? tokensByAccount.get(selected.id) : undefined
  const selectedGroups = useMemo<readonly AuthGroupOption[]>(
    () => (selected ? selected.groupIds.map((id) => groupsById.get(id) ?? { id }) : []),
    [selected, groupsById]
  )

  const refreshTokens = (serviceAccountId: string) =>
    queryClient.invalidateQueries({
      queryKey: listAuthServiceAccountAccessTokensQueryKey({ path: { serviceAccountId } }),
    })

  const createAccount = useMutation({
    ...createAuthServiceAccountMutation(),
    onSuccess: async (result) => {
      setCreateOpen(false)
      await queryClient.invalidateQueries({ queryKey: listAuthServiceAccountsQueryKey() })
      setSelectedId(result.serviceAccount.id)
    },
  })

  const disableAccount = useMutation({
    ...disableAuthServiceAccountMutation(),
    onSuccess: async () => {
      notify.success(messages.disabled)
      await queryClient.invalidateQueries({ queryKey: listAuthServiceAccountsQueryKey() })
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.disableFailed)),
  })

  const createToken = useMutation({
    ...createAuthServiceAccountAccessTokenMutation(),
    onSuccess: async (result) => {
      setCreatedToken({ tokenValue: result.tokenValue, name: result.accessToken.name })
      await refreshTokens(result.accessToken.subject.id)
    },
  })

  const revokeToken = useMutation({
    ...revokeAuthServiceAccountAccessTokenMutation(),
    onSuccess: async (result) => {
      notify.success(messages.tokenRevoked)
      await refreshTokens(result.accessToken.subject.id)
    },
    onError: (error) => notify.error(apiErrorMessage(error, messages.revokeFailed)),
  })

  const handleTokenDialogChange = (open: boolean) => {
    setTokenDialogOpen(open)
    if (open) {
      createToken.reset()
      setCreatedToken(null)
    } else {
      // Forget the revealed value after the exit animation, so the form never flashes back.
      window.setTimeout(() => setCreatedToken(null), 200)
    }
  }

  const newAccountButton = canManage ? (
    <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
      <Plus />
      {messages.newAccount}
    </Button>
  ) : null

  return (
    <>
      <Panel>
        {optionsQuery.isPending || accountsQuery.isPending ? (
          <PanelSkeleton rows={3} />
        ) : accountsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Bot}
            title={messages.unavailable}
            description={apiErrorMessage(accountsQuery.error, messages.loadFailed)}
          />
        ) : accounts.length === 0 ? (
          canManage ? (
            <PanelEmpty
              icon={Bot}
              title={messages.emptyTitle}
              description={messages.emptyDescription}
              action={newAccountButton}
            />
          ) : (
            <PanelEmpty
              icon={Lock}
              title={messages.notAllowedTitle}
              description={messages.notAllowedDescription}
            />
          )
        ) : (
          accounts.map((account) => {
            const tokens = tokensByAccount.get(account.id)
            return (
              <PanelRow
                key={account.id}
                onClick={() => setSelectedId(account.id)}
                muted={account.status !== "active"}
                leading={<AccountMark name={account.name} />}
                title={
                  <>
                    <span className="truncate">{account.name}</span>
                    {account.status === "active" ? null : (
                      <Pill tone="muted">{messages.status.disabled}</Pill>
                    )}
                  </>
                }
                meta={
                  <>
                    <span className="font-mono text-xs">{maskId(account.id, "svc_")}</span>
                    <MetaDot />
                    <span>
                      {!tokens || tokens.loading ? "…" : messages.tokenCount(tokens.tokens.length)}
                    </span>
                    {account.description ? (
                      <>
                        <MetaDot />
                        <span className="truncate">{account.description}</span>
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  <>
                    <span className="hidden md:inline-flex">
                      <GroupChips groupIds={account.groupIds} groupsById={groupsById} />
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
                  </>
                }
              />
            )
          })
        )}
      </Panel>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (open) return
          setSelectedId(null)
          setTokenDialogOpen(false)
          setCreatedToken(null)
        }}
      >
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
          {selected ? (
            <>
              <div className="flex flex-col gap-4 border-b border-border p-6 pr-12">
                <AccountMark name={selected.name} size="lg" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <SheetTitle className="truncate text-lg tracking-[-0.01em]">
                      {selected.name}
                    </SheetTitle>
                    {selected.status === "active" ? (
                      <Pill tone="ok">{messages.status.active}</Pill>
                    ) : (
                      <Pill tone="muted">{messages.status.disabled}</Pill>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <span className="truncate">{selected.id}</span>
                    <CopyIdButton value={selected.id} label={messages.copyId} />
                  </div>
                </div>
                <SheetDescription>
                  {selected.description || messages.noDescription}
                </SheetDescription>
                <dl className="grid grid-cols-2 gap-4 text-[0.8125rem]">
                  <div className="min-w-0">
                    <dt className="text-muted-foreground">{messages.groups}</dt>
                    <dd className="mt-1.5">
                      <GroupChips groupIds={selected.groupIds} groupsById={groupsById} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{messages.created}</dt>
                    <dd className="mt-1.5 font-medium">{format.date(selected.createdAt)}</dd>
                  </div>
                </dl>
              </div>

              <div className="flex flex-1 flex-col gap-5 overflow-auto p-6">
                <PageSection
                  title={messages.tokens}
                  action={
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={selected.status !== "active"}
                      onClick={() => handleTokenDialogChange(true)}
                    >
                      <Plus />
                      {messages.newToken}
                    </Button>
                  }
                >
                  {selected.status !== "active" ? (
                    <p className="text-[0.8125rem] text-muted-foreground">
                      {messages.disabledNote}
                    </p>
                  ) : null}
                  <Panel>
                    {selectedTokens?.loading ? (
                      <PanelSkeleton rows={1} />
                    ) : (
                      <TokenRows
                        tokens={selectedTokens?.tokens ?? []}
                        groupsById={groupsById}
                        showGroups={false}
                        revokingTokenId={revokingTokenId}
                        onRevoke={(tokenId) => {
                          setRevokingTokenId(tokenId)
                          revokeToken.mutate(
                            { path: { serviceAccountId: selected.id, tokenId } },
                            { onSettled: () => setRevokingTokenId(null) }
                          )
                        }}
                        empty={
                          <PanelEmpty
                            icon={KeyRound}
                            title={messages.tokensEmptyTitle}
                            description={messages.tokensEmptyDescription}
                          />
                        }
                      />
                    )}
                  </Panel>
                </PageSection>

                {selected.status === "active" ? (
                  <div className="mt-auto flex items-center justify-between gap-4 rounded-xl border border-destructive/20 bg-destructive/[0.03] px-4 py-3.5">
                    <p className="max-w-[36ch] text-[0.8125rem] text-muted-foreground">
                      {messages.disableHint}
                    </p>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={disableAccount.isPending}
                          className="shrink-0 text-destructive hover:text-destructive"
                        >
                          {disableAccount.isPending ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Power />
                          )}
                          {messages.disable}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {messages.disableTitle(selected.name)}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {messages.disableDescription}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{allMessages.common.cancel}</AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() =>
                              disableAccount.mutate({ path: { serviceAccountId: selected.id } })
                            }
                          >
                            {messages.disable}
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

      <CreateAccountDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          createAccount.reset()
        }}
        groups={groups ?? []}
        onSubmit={(body) => createAccount.mutate({ body })}
        isSubmitting={createAccount.isPending}
        errorMessage={
          createAccount.isError
            ? apiErrorMessage(createAccount.error, messages.form.createFailed)
            : null
        }
      />

      <TokenFormDialog
        open={tokenDialogOpen}
        onOpenChange={handleTokenDialogChange}
        kind="service"
        groups={selectedGroups}
        defaultGroupIds={selected?.groupIds ?? []}
        onSubmit={(body) => {
          if (selected) createToken.mutate({ path: { serviceAccountId: selected.id }, body })
        }}
        isSubmitting={createToken.isPending}
        errorMessage={
          createToken.isError
            ? apiErrorMessage(createToken.error, messages.tokenCreateFailed)
            : null
        }
        created={createdToken}
        disabled={selected?.status !== "active"}
      />
    </>
  )
}

function CopyIdButton({ value, label }: { readonly value: string; readonly label: string }) {
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
      className="inline-grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function CreateAccountDialog({
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
  const allMessages = useSettingsMessages()
  const messages = allMessages.serviceAccounts.form
  const [name, setName] = useState("")
  const [customId, setCustomId] = useState("")
  const [description, setDescription] = useState("")
  const [groupIds, setGroupIds] = useState<readonly string[]>([])

  useEffect(() => {
    if (!open) return
    setName("")
    setCustomId("")
    setDescription("")
    setGroupIds([])
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
      groupIds: [...groupIds],
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
            <Field label={messages.name} htmlFor="service-account-name">
              <Input
                id="service-account-name"
                value={name}
                autoComplete="off"
                autoFocus
                onChange={(event) => setName(event.target.value)}
                placeholder={messages.namePlaceholder}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label={
                  <>
                    {messages.identifier}{" "}
                    <span className="font-normal text-muted-foreground">({messages.optional})</span>
                  </>
                }
                htmlFor="service-account-id"
                hint={messages.identifierHint}
              >
                <Input
                  id="service-account-id"
                  value={customId}
                  autoComplete="off"
                  onChange={(event) => setCustomId(event.target.value)}
                  placeholder={messages.identifierPlaceholder}
                  className="font-mono text-xs"
                />
              </Field>
              <Field label={messages.descriptionLabel} htmlFor="service-account-description">
                <Input
                  id="service-account-description"
                  value={description}
                  autoComplete="off"
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={messages.descriptionPlaceholder}
                />
              </Field>
            </div>
            <Field label={messages.groups} hint={messages.groupsHint}>
              <GroupPicker
                groups={groups}
                selectedGroupIds={groupIds}
                onChange={setGroupIds}
                disabled={isSubmitting}
                emptyMessage={messages.noGroups}
              />
            </Field>
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
              {messages.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
