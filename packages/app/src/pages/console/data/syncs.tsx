import { getSyncOptions, listSyncRunsOptions, listSyncsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { CalendarClock, ChevronRight, RefreshCw } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import { DetailFallback, SectionPage } from "../../section-page"
import {
  apiErrorMessage,
  Facts,
  FailureSummary,
  formatDuration,
  humanize,
  isUnrecorded,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  RunStatusPill,
  Stats,
  UnrecordedHistory,
  useFormat,
  useNumbers,
  useRunStatusLabels,
} from "../../section-ui"
import { useSyncLiveUpdates } from "./live-updates"
import { useDataMessages } from "./messages"
import { SchemaPanel } from "./schema"
import { ConnectorIcon, ScheduleMeta } from "./shared"
import { SyncButton } from "./sync-button"

/** Console › Syncs: what copies each connector's data into the project, and how it last went. */
export function ConsoleSyncsPage() {
  const messages = useDataMessages()
  const format = useFormat()
  useSyncLiveUpdates()
  const syncsQuery = useQuery({ ...listSyncsOptions(), retry: false })
  const syncs = syncsQuery.data ?? []

  return (
    <SectionPage
      section="console"
      page="syncs"
      title={messages.syncs.title}
      description={messages.syncs.description}
    >
      <Panel>
        {syncsQuery.isPending ? (
          <PanelSkeleton rows={3} />
        ) : syncsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={RefreshCw}
            title={messages.syncs.title}
            description={apiErrorMessage(syncsQuery.error, messages.common.loadFailed)}
          />
        ) : syncs.length === 0 ? (
          <PanelEmpty
            icon={RefreshCw}
            title={messages.syncs.emptyTitle}
            description={messages.syncs.emptyDescription}
          />
        ) : (
          syncs.map((sync) => (
            <PanelRow
              key={sync.id}
              href={`/console/syncs/${encodeURIComponent(sync.id)}`}
              leading={<ConnectorIcon type={sync.connector.type} />}
              title={<span className="truncate">{humanize(sync.id)}</span>}
              meta={
                <>
                  <span>{messages.common.modes[sync.mode]}</span>
                  <MetaDot />
                  <span className="truncate">{messages.common.writes(sync.target.dataset.id)}</span>
                  {sync.triggers.map((trigger) => (
                    <ScheduleMeta key={trigger.scheduleId} id={trigger.scheduleId} />
                  ))}
                  {sync.latestRun ? (
                    <>
                      <MetaDot />
                      <span>
                        {format.relative(sync.latestRun.startedAt ?? sync.latestRun.queuedAt)}
                      </span>
                    </>
                  ) : null}
                </>
              }
              trailing={
                <>
                  {sync.latestRun ? (
                    <RunStatusPill status={sync.latestRun.status} />
                  ) : (
                    <Pill tone="muted">{messages.common.neverRun}</Pill>
                  )}
                  <ChevronRight className="size-4 text-muted-foreground/60" />
                </>
              }
            />
          ))
        )}
      </Panel>
    </SectionPage>
  )
}

/** One sync: run it, how its runs went, and what it writes. */
export function ConsoleSyncPage() {
  const statusLabels = useRunStatusLabels()
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  const syncId = useParams().syncId ?? ""
  // The page's SyncButton keeps this sync and its runs live.
  const syncQuery = useQuery({ ...getSyncOptions({ path: { syncId } }), retry: false })
  const runsQuery = useQuery({
    ...listSyncRunsOptions({ query: { syncId, limit: "20", order: "desc" } }),
    retry: false,
    // Polling covers a dropped event stream while a run is under way.
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running")
        ? 5000
        : false,
  })
  const sync = syncQuery.data
  const back = { href: "/console/syncs", label: messages.syncs.title }

  if (!sync) {
    return (
      <DetailFallback
        section="console"
        page="syncs"
        back={back}
        name={humanize(syncId)}
        id={syncId}
        icon={RefreshCw}
        error={syncQuery.error}
      />
    )
  }

  const latestRun = sync.latestRun
  // A failed latest run gets its own panel; its row leaves the failure out rather than repeat it.
  const failedLatest = latestRun?.status === "failed" && latestRun.error ? latestRun : null
  const dataset = sync.target.dataset
  const datasetHref = `/console/datasets/${encodeURIComponent(dataset.id)}`

  return (
    <SectionPage
      section="console"
      page="syncs"
      back={back}
      icon={<ConnectorIcon type={sync.connector.type} size="lg" />}
      title={humanize(sync.id)}
      meta={
        <>
          {latestRun ? (
            <RunStatusPill status={latestRun.status} />
          ) : (
            <Pill tone="muted">{messages.common.neverRun}</Pill>
          )}
          <span>{messages.common.modes[sync.mode]}</span>
          <MetaDot />
          <Link to={datasetHref} className="hover:text-foreground hover:underline">
            {messages.common.writes(dataset.id)}
          </Link>
        </>
      }
      actions={<SyncButton sync={sync.id} variant="default" />}
    >
      <Stats
        items={[
          {
            label: messages.common.lastRun,
            value: latestRun ? (
              statusLabels[latestRun.status]
            ) : (
              <span className="text-muted-foreground">{messages.common.neverRun}</span>
            ),
          },
          {
            label: messages.common.started,
            value: latestRun ? format.relative(latestRun.startedAt ?? latestRun.queuedAt) : "—",
          },
          {
            label: messages.common.took,
            value: formatDuration(latestRun?.startedAt, latestRun?.finishedAt),
          },
          { label: messages.syncs.rowsRead, value: numbers.count(latestRun?.rowsRead) },
        ]}
      />

      {failedLatest?.error ? (
        <PageSection title={messages.common.lastRunFailed}>
          <Panel>
            <div className="px-5 py-4">
              <FailureSummary failure={failedLatest.error} />
            </div>
          </Panel>
        </PageSection>
      ) : null}

      <PageSection title={messages.common.runs} description={messages.common.runsDescription}>
        <Panel>
          {runsQuery.isPending ? (
            <PanelSkeleton rows={3} />
          ) : runsQuery.isError ? (
            isUnrecorded(runsQuery.error) ? (
              <UnrecordedHistory what={messages.syncs.runWhat} />
            ) : (
              <PanelEmpty
                tone="error"
                icon={RefreshCw}
                title={messages.common.runs}
                description={apiErrorMessage(runsQuery.error, messages.common.loadFailed)}
              />
            )
          ) : runsQuery.data.runs.length === 0 ? (
            <PanelEmpty icon={RefreshCw} title={messages.common.noRunsTitle} />
          ) : (
            runsQuery.data.runs.map((run) => (
              <PanelRow
                key={run.id}
                title={format.dateTime(run.startedAt ?? run.queuedAt)}
                meta={
                  <>
                    <span>{messages.common.modes[run.mode]}</span>
                    {run.finishedAt ? (
                      <>
                        <MetaDot />
                        <span className="tabular-nums">
                          {formatDuration(run.startedAt, run.finishedAt)}
                        </span>
                      </>
                    ) : null}
                    {run.rowsRead !== undefined ? (
                      <>
                        <MetaDot />
                        <span className="tabular-nums">
                          {messages.common.rows(run.rowsRead, numbers.count(run.rowsRead))}
                        </span>
                      </>
                    ) : null}
                    {run.output ? (
                      <>
                        <MetaDot />
                        <Link
                          to={`${datasetHref}?version=${encodeURIComponent(run.output.versionId)}`}
                          className="font-mono text-xs hover:text-foreground hover:underline"
                        >
                          {run.output.versionId.slice(0, 12)}
                        </Link>
                      </>
                    ) : null}
                    {run.commitMessage ? (
                      <>
                        <MetaDot />
                        <span className="truncate">{run.commitMessage}</span>
                      </>
                    ) : null}
                  </>
                }
                trailing={<RunStatusPill status={run.status} />}
              >
                {run.error && run.id !== failedLatest?.id ? (
                  <FailureSummary failure={run.error} compact />
                ) : null}
              </PanelRow>
            ))
          )}
        </Panel>
      </PageSection>

      <PageSection title={messages.common.details}>
        <Panel>
          <Facts
            items={[
              {
                label: messages.syncs.connector,
                value: (
                  <Link
                    to={`/console/connectors/${encodeURIComponent(sync.connector.id)}`}
                    className="hover:underline"
                  >
                    {humanize(sync.connector.id)}
                  </Link>
                ),
              },
              {
                label: messages.syncs.dataset,
                value: (
                  <Link to={datasetHref} className="font-mono text-xs hover:underline">
                    {dataset.id}
                  </Link>
                ),
              },
              { label: messages.common.mode, value: messages.common.modes[sync.mode] },
              ...(sync.triggers.length > 0
                ? [
                    {
                      label: messages.common.schedules,
                      value: (
                        <span className="flex flex-wrap gap-1.5">
                          {sync.triggers.map((trigger) => (
                            <span
                              key={trigger.scheduleId}
                              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 font-mono text-xs"
                            >
                              <CalendarClock className="size-3.5 text-muted-foreground" />
                              {trigger.scheduleId}
                            </span>
                          ))}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </Panel>
      </PageSection>

      <SchemaPanel dataset={dataset} />
    </SectionPage>
  )
}
