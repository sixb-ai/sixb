import type { ListConnectorAccountsResponse, ListSyncsResponse } from "@sixb/client"
import {
  listConnectorAccountsOptions,
  listConnectorAccountsQueryKey,
  listSyncRunsQueryKey,
  listSyncsQueryKey,
  requestSyncRunMutation,
} from "@sixb/client/hooks"
import { Button, Input } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Building2, RefreshCw, Search, Users } from "lucide-react"
import { Fragment, useState } from "react"
import { Link } from "react-router-dom"
import {
  apiErrorMessage,
  FailureSummary,
  humanize,
  IconTile,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  RunStatusPill,
  useFormat,
  useNumbers,
} from "../../section-ui"
import { PersonAvatar } from "../../settings/controls"
import { TrailingSkeleton } from "../skeletons"
import { useDataMessages } from "./messages"

type ConnectorAccount = ListConnectorAccountsResponse["accounts"][number]
type AccountRun = ConnectorAccount["latestRuns"][number]
type Sync = ListSyncsResponse[number]

/** How many accounts show before "Show all". Problems sort first, so they always show. */
const SHOWN_ACCOUNTS = 8
/** Past this many accounts, the panel offers a search. */
const SEARCHABLE_ACCOUNTS = 20

export function isActiveRun(status: AccountRun["status"] | undefined): boolean {
  return status === "queued" || status === "running"
}

export function needsReconnecting(run: AccountRun | null | undefined): boolean {
  return run?.status === "failed" && run.error?.code === "connector.authorization_required"
}

/** The connector's accounts, kept fresh while one of their runs is under way. */
export function useConnectorAccounts(connectorId: string, enabled = true) {
  return useQuery({
    ...listConnectorAccountsOptions({ path: { connectorId } }),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.accounts.some(({ latestRuns }) =>
        latestRuns.some((run) => isActiveRun(run.status))
      )
        ? 5000
        : false,
  })
}

type AccountState = "reconnect" | "failed" | "running" | "never" | "synced"

const stateOrder: Record<AccountState, number> = {
  reconnect: 0,
  failed: 1,
  running: 2,
  never: 3,
  synced: 4,
}

/** One state for an account across its syncs: what most needs someone's attention. */
function accountState(account: ConnectorAccount): AccountState {
  const runs = account.latestRuns
  if (runs.some(needsReconnecting)) return "reconnect"
  if (runs.some((run) => run.status === "failed")) return "failed"
  if (runs.some((run) => isActiveRun(run.status))) return "running"
  return runs.length === 0 ? "never" : "synced"
}

/** On a sync's row or page: how many accounts it runs for, and how many are not syncing. */
export function AccountsMeta({
  summary,
  href,
}: {
  readonly summary: NonNullable<Sync["accounts"]>
  /** The connector's accounts, when the count should lead there. */
  readonly href?: string
}) {
  const messages = useDataMessages().syncs
  const numbers = useNumbers()
  const count = (
    <span className="inline-flex items-center gap-1">
      <Users aria-hidden className="size-3.5" />
      {messages.accounts(summary.total, numbers.count(summary.total))}
    </span>
  )
  return (
    <>
      <MetaDot />
      {href ? (
        <Link to={href} className="hover:text-foreground hover:underline">
          {count}
        </Link>
      ) : (
        count
      )}
      {summary.needsReconnecting > 0 ? (
        <>
          <MetaDot />
          <span className="text-amber-700 dark:text-amber-400">
            {messages.needReconnecting(summary.needsReconnecting)}
          </span>
        </>
      ) : null}
      {summary.failing > 0 ? (
        <>
          <MetaDot />
          <span className="text-red-600 dark:text-red-400">
            {messages.failingAccounts(summary.failing)}
          </span>
        </>
      ) : null}
    </>
  )
}

/** An OAuth connector's connected accounts, the ones that need attention first. */
export function ConnectorAccountsSection({
  connectorId,
  syncs,
}: {
  readonly connectorId: string
  /** The connector's syncs the viewer may run. */
  readonly syncs: readonly Sync[]
}) {
  const messages = useDataMessages()
  const numbers = useNumbers()
  const query = useConnectorAccounts(connectorId)
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState("")

  const accounts = [...(query.data?.accounts ?? [])].sort(
    (left, right) =>
      stateOrder[accountState(left)] - stateOrder[accountState(right)] ||
      left.connection.account.label.localeCompare(right.connection.account.label)
  )
  const needle = search.trim().toLowerCase()
  const matching = needle
    ? accounts.filter(({ connection }) => connection.account.label.toLowerCase().includes(needle))
    : accounts
  const shown = showAll || needle ? matching : matching.slice(0, SHOWN_ACCOUNTS)

  return (
    <PageSection
      title={messages.connectors.accountsTitle}
      description={messages.connectors.accountsDescription}
      action={
        accounts.length > SEARCHABLE_ACCOUNTS ? (
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={messages.connectors.searchAccounts}
              aria-label={messages.connectors.searchAccounts}
              className="h-8 pl-8 text-xs"
            />
          </div>
        ) : null
      }
    >
      <Panel>
        {query.isPending ? (
          <PanelSkeleton rows={2} leading="avatar" trailing={<TrailingSkeleton />} />
        ) : query.isError ? (
          <PanelEmpty
            tone="error"
            icon={Users}
            title={messages.connectors.accountsTitle}
            description={apiErrorMessage(query.error, messages.common.loadFailed)}
          />
        ) : accounts.length === 0 ? (
          <PanelEmpty icon={Users} title={messages.connectors.noAccountsTitle} />
        ) : matching.length === 0 ? (
          <PanelEmpty icon={Search} title={messages.connectors.noMatchingAccounts} />
        ) : (
          <>
            {shown.map((account) => (
              <AccountRow
                key={account.connection.id}
                connectorId={connectorId}
                account={account}
                syncs={syncs}
              />
            ))}
            {shown.length < matching.length ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="w-full px-4 py-3 text-left text-[0.8125rem] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              >
                {messages.connectors.showAllAccounts(numbers.count(matching.length))}
              </button>
            ) : null}
          </>
        )}
      </Panel>
    </PageSection>
  )
}

function AccountRow({
  connectorId,
  account,
  syncs,
}: {
  readonly connectorId: string
  readonly account: ConnectorAccount
  readonly syncs: readonly Sync[]
}) {
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  const { connection, latestRuns } = account
  const label = connection.account.label
  const isProject = connection.owner.type === "project"
  const state = accountState(account)
  const failure = latestRuns.find((run) => run.status === "failed" && !needsReconnecting(run))
  const when = (run: AccountRun) => format.relative(run.finishedAt ?? run.startedAt ?? run.queuedAt)
  const [onlyRun] = latestRuns

  return (
    <PanelRow
      leading={isProject ? <IconTile icon={Building2} /> : <PersonAvatar email={label} />}
      title={<span className="truncate">{label}</span>}
      meta={
        <>
          {isProject ? (
            <>
              <span>{messages.syncs.project}</span>
              <MetaDot />
            </>
          ) : null}
          {connection.slot !== "default" ? (
            <>
              <span>{messages.syncs.slot(connection.slot)}</span>
              <MetaDot />
            </>
          ) : null}
          {latestRuns.length === 0 ? (
            <span>{messages.syncs.notSyncedYet}</span>
          ) : syncs.length <= 1 && onlyRun ? (
            // One sync: when it last ran, and what it read.
            <>
              <span>{when(onlyRun)}</span>
              {onlyRun.rowsRead !== undefined ? (
                <>
                  <MetaDot />
                  <span className="tabular-nums">
                    {messages.common.rows(onlyRun.rowsRead, numbers.count(onlyRun.rowsRead))}
                  </span>
                </>
              ) : null}
            </>
          ) : (
            // Several syncs: each one's last run, by name. Stacked on a narrow screen.
            <span className="flex min-w-0 flex-col sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5">
              {latestRuns.map((run, index) => (
                <Fragment key={run.syncId}>
                  {index > 0 ? (
                    <span className="hidden sm:inline">
                      <MetaDot />
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      "truncate",
                      needsReconnecting(run)
                        ? "text-amber-700 dark:text-amber-400"
                        : run.status === "failed" && "text-red-600 dark:text-red-400"
                    )}
                  >
                    {humanize(run.syncId)} {when(run)}
                  </span>
                </Fragment>
              ))}
            </span>
          )}
        </>
      }
      trailing={
        <>
          <AccountSyncButton connectorId={connectorId} account={account} syncs={syncs} />
          {state === "never" ? (
            <Pill tone="muted">{messages.syncs.notSyncedYet}</Pill>
          ) : state === "reconnect" ? (
            <Pill tone="warn">{messages.syncs.needsReconnecting}</Pill>
          ) : (
            <RunStatusPill
              status={state === "failed" ? "failed" : state === "running" ? "running" : "succeeded"}
            />
          )}
        </>
      }
    >
      {failure?.error ? <FailureSummary failure={failure.error} compact /> : null}
    </PanelRow>
  )
}

/** Runs every sync of one account now. Shown on hover, and always on touch screens. */
function AccountSyncButton({
  connectorId,
  account,
  syncs,
}: {
  readonly connectorId: string
  readonly account: ConnectorAccount
  readonly syncs: readonly Sync[]
}) {
  const messages = useDataMessages().syncs
  const queryClient = useQueryClient()
  const label = account.connection.account.label
  const request = useMutation({
    ...requestSyncRunMutation(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: listConnectorAccountsQueryKey({ path: { connectorId } }),
        }),
        queryClient.invalidateQueries({ queryKey: listSyncsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: listSyncRunsQueryKey() }),
      ]),
  })
  const working = request.isPending || account.latestRuns.some((run) => isActiveRun(run.status))
  if (syncs.length === 0) return null

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={messages.syncAccount(label)}
      title={messages.syncAccount(label)}
      disabled={working}
      onClick={async () => {
        // One sync refusing, such as one this person may not run, leaves the others to run.
        for (const sync of syncs) {
          await request
            .mutateAsync({
              path: { syncId: sync.id },
              body: { connectionId: account.connection.id },
            })
            .catch(() => undefined)
        }
      }}
      className={cn(
        "text-muted-foreground transition-opacity",
        !working &&
          "focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
      )}
    >
      <RefreshCw className={cn(working && "animate-spin")} />
    </Button>
  )
}
