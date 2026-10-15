import type { ListProjectionRunsResponse, ListProjectionsResponse } from "@sixb/client"
import {
  events,
  getProjectionOptions,
  listProjectionRunsOptions,
  listProjectionsOptions,
  useEvents,
} from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Activity, ArrowRight, Box, ChevronRight, Layers, Link2 } from "lucide-react"
import { type ComponentType, type ReactNode, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { DetailFallback, SectionPage } from "../section-page"
import {
  apiErrorMessage,
  Facts,
  FailureSummary,
  formatDuration,
  humanize,
  IconTile,
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
  ToolbarTabs,
  UnrecordedHistory,
  useFormat,
  useNumbers,
  useRunStatusLabels,
} from "../section-ui"
import { useDataMessages } from "./messages"

type Projection =
  | ListProjectionsResponse["objectProjections"][number]
  | ListProjectionsResponse["linkProjections"][number]
  | ListProjectionsResponse["telemetryProjections"][number]
type ProjectionRun = ListProjectionRunsResponse["runs"][number]
type ProjectionKind = "object" | "link" | "telemetry"
type Tab = "all" | ProjectionKind

const kindIcons: Record<ProjectionKind, ComponentType<{ readonly className?: string }>> = {
  object: Box,
  link: Link2,
  telemetry: Activity,
}

function kindOf(projection: Pick<Projection, "_tag">): ProjectionKind {
  if (projection._tag === "ObjectProjectionDefinition") return "object"
  if (projection._tag === "LinkProjectionDefinition") return "link"
  return "telemetry"
}

/** What a projection fills: an object type, or the two ends of a link. */
function targetOf(projection: Projection): string {
  return projection._tag === "LinkProjectionDefinition"
    ? `${projection.sourceObjectTypeId} → ${projection.targetObjectTypeId}`
    : projection.objectTypeId
}

const RUN_POLL_MS = 5000
// A commit queues its run when the orchestrator dispatches the commit event, or at the latest on
// the orchestrator's next 30s reconciliation pass.
const COMMIT_WATCH_MS = 60_000

/** Runs publish no events: poll while one is pending, or for a while after its dataset commits. */
export function projectionRunsPollInterval(
  runs: readonly Pick<ProjectionRun, "status">[],
  committedAt: number,
  now = Date.now()
): number | false {
  const pending = runs.some((run) => run.status === "queued" || run.status === "running")
  return pending || now - committedAt < COMMIT_WATCH_MS ? RUN_POLL_MS : false
}

/** Data › Projections: how datasets become objects, links and telemetry. */
export function DataProjectionsPage() {
  const messages = useDataMessages()
  const format = useFormat()
  const [tab, setTab] = useState<Tab>("all")
  const projectionsQuery = useQuery({ ...listProjectionsOptions(), retry: false })
  const data = projectionsQuery.data
  const all: readonly Projection[] = data
    ? [...data.objectProjections, ...data.linkProjections, ...data.telemetryProjections]
    : []
  const shown = tab === "all" ? all : all.filter((projection) => kindOf(projection) === tab)
  const count = (kind: ProjectionKind) => all.filter((p) => kindOf(p) === kind).length
  // A kind the project has none of gets no tab, so no tab is ever empty.
  const tabs = (
    [
      { id: "all", label: messages.projections.tabs.all, count: all.length },
      { id: "object", label: messages.projections.tabs.object, count: count("object") },
      { id: "link", label: messages.projections.tabs.link, count: count("link") },
      { id: "telemetry", label: messages.projections.tabs.telemetry, count: count("telemetry") },
    ] satisfies { id: Tab; label: string; count: number }[]
  ).filter((entry) => entry.id === "all" || entry.count > 0)

  return (
    <SectionPage
      section="data"
      page="projections"
      title={messages.projections.title}
      description={messages.projections.description}
    >
      <Panel
        toolbar={
          all.length > 0 ? <ToolbarTabs value={tab} onChange={setTab} tabs={tabs} /> : undefined
        }
      >
        {projectionsQuery.isPending ? (
          <PanelSkeleton rows={3} />
        ) : projectionsQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={Layers}
            title={messages.projections.title}
            description={apiErrorMessage(projectionsQuery.error, messages.common.loadFailed)}
          />
        ) : shown.length === 0 ? (
          <PanelEmpty
            icon={Layers}
            title={messages.projections.emptyTitle}
            description={messages.projections.emptyDescription}
          />
        ) : (
          shown.map((projection) => {
            const kind = kindOf(projection)
            return (
              <PanelRow
                key={projection.id}
                href={`/data/projections/${encodeURIComponent(projection.id)}`}
                leading={<IconTile icon={kindIcons[kind]} />}
                title={<span className="truncate">{humanize(projection.id)}</span>}
                meta={
                  <>
                    <span>{messages.projections.kinds[kind]}</span>
                    <MetaDot />
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <span className="truncate font-mono text-xs">{projection.datasetId}</span>
                      <ArrowRight className="size-3 shrink-0" />
                      <span className="truncate">{targetOf(projection)}</span>
                    </span>
                    {projection.latestRun ? (
                      <>
                        <MetaDot />
                        <span>
                          {format.relative(
                            projection.latestRun.startedAt ?? projection.latestRun.queuedAt
                          )}
                        </span>
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  <>
                    {projection.latestRun ? (
                      <RunStatusPill status={projection.latestRun.status} />
                    ) : (
                      <Pill tone="muted">{messages.common.neverRun}</Pill>
                    )}
                    <ChevronRight className="size-4 text-muted-foreground/60" />
                  </>
                }
              />
            )
          })
        )}
      </Panel>
    </SectionPage>
  )
}

/** One projection: what it reads and fills, field by field, and its runs. */
export function DataProjectionPage() {
  const statusLabels = useRunStatusLabels()
  const messages = useDataMessages()
  const format = useFormat()
  const numbers = useNumbers()
  const projectionId = useParams().projectionId ?? ""
  const projectionQuery = useQuery({
    ...getProjectionOptions({ path: { projectionId } }),
    retry: false,
  })
  const datasetId = projectionQuery.data?.datasetId ?? ""
  const [committedAt, setCommittedAt] = useState(0)
  useEvents(
    events.datasets(),
    (event) => {
      if (event.payload.datasetId === datasetId) setCommittedAt(Date.now())
    },
    { enabled: datasetId.length > 0 }
  )
  const runsQuery = useQuery({
    ...listProjectionRunsOptions({ query: { projectionId, limit: "20", order: "desc" } }),
    retry: false,
    refetchInterval: (query) =>
      projectionRunsPollInterval(query.state.data?.runs ?? [], committedAt),
  })

  const projection = projectionQuery.data
  const back = { href: "/data/projections", label: messages.projections.title }

  if (!projection) {
    return (
      <DetailFallback
        section="data"
        page="projections"
        back={back}
        name={humanize(projectionId)}
        id={projectionId}
        icon={Layers}
        error={projectionQuery.error}
      />
    )
  }

  const kind = kindOf(projection)
  const runs = runsQuery.data?.runs ?? []
  // A superseded run never counts as the latest: the run that replaced it does.
  const latestRun = runs.find((run) => run.status !== "superseded") ?? projection.latestRun ?? null
  // A failed latest run gets its own panel; its row leaves the failure out rather than repeat it.
  const failedLatest = latestRun?.status === "failed" && latestRun.error ? latestRun : null
  const datasetHref = `/data/datasets/${encodeURIComponent(projection.datasetId)}`

  return (
    <SectionPage
      section="data"
      page="projections"
      back={back}
      icon={<IconTile icon={kindIcons[kind]} size="lg" />}
      title={humanize(projection.id)}
      meta={
        <>
          {latestRun ? (
            <RunStatusPill status={latestRun.status} />
          ) : (
            <Pill tone="muted">{messages.common.neverRun}</Pill>
          )}
          <span>{messages.projections.kinds[kind]}</span>
          <MetaDot />
          <span className="inline-flex items-center gap-1">
            <Link
              to={datasetHref}
              className="font-mono text-xs hover:text-foreground hover:underline"
            >
              {projection.datasetId}
            </Link>
            <ArrowRight className="size-3" />
            <span>{targetOf(projection)}</span>
          </span>
        </>
      }
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
          {
            label: messages.projections.rowsRead,
            value: latestRun ? numbers.count(latestRun.progress.sourceRowsRead) : "—",
          },
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

      <PageSection
        title={messages.projections.mappingTitle}
        description={messages.projections.mappingDescription}
      >
        <Panel>
          <Mapping projection={projection} />
        </Panel>
      </PageSection>

      <PageSection title={messages.common.runs} description={messages.common.runsDescription}>
        <Panel>
          {runsQuery.isPending ? (
            <PanelSkeleton rows={3} />
          ) : runsQuery.isError ? (
            isUnrecorded(runsQuery.error) ? (
              <UnrecordedHistory what={messages.projections.runWhat} />
            ) : (
              <PanelEmpty
                tone="error"
                icon={Layers}
                title={messages.common.runs}
                description={apiErrorMessage(runsQuery.error, messages.common.loadFailed)}
              />
            )
          ) : runs.length === 0 ? (
            <PanelEmpty icon={Layers} title={messages.common.noRunsTitle} />
          ) : (
            runs.map((run) => (
              <PanelRow
                key={run.id}
                muted={run.status === "superseded"}
                title={format.dateTime(run.startedAt ?? run.queuedAt)}
                meta={
                  <>
                    <Link
                      to={`${datasetHref}?version=${encodeURIComponent(run.identity.datasetVersion.versionId)}`}
                      className="font-mono text-xs hover:text-foreground hover:underline"
                    >
                      {run.identity.datasetVersion.versionId.slice(0, 12)}
                    </Link>
                    <MetaDot />
                    <span className="tabular-nums">
                      {messages.common.rows(
                        run.progress.sourceRowsRead,
                        numbers.count(run.progress.sourceRowsRead)
                      )}
                    </span>
                    {run.progress.sourceRowsSkipped > 0 ? (
                      <>
                        <MetaDot />
                        <span className="tabular-nums">
                          {messages.projections.rowsSkipped(
                            run.progress.sourceRowsSkipped,
                            numbers.count(run.progress.sourceRowsSkipped)
                          )}
                        </span>
                      </>
                    ) : null}
                    {run.finishedAt ? (
                      <>
                        <MetaDot />
                        <span className="tabular-nums">
                          {formatDuration(run.startedAt, run.finishedAt)}
                        </span>
                      </>
                    ) : null}
                    {run.attempt > 1 ? (
                      <>
                        <MetaDot />
                        <span>{messages.projections.attempt(run.attempt)}</span>
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
    </SectionPage>
  )
}

function Mapping({ projection }: { readonly projection: Projection }) {
  const messages = useDataMessages().projections
  const column = (name: string) => <span className="font-mono text-xs">{name}</span>

  if (projection._tag === "LinkProjectionDefinition") {
    return (
      <Facts
        items={[
          {
            label: messages.link,
            value: <span className="font-mono text-xs">{projection.linkId}</span>,
          },
          {
            label: messages.sourceField,
            value: (
              <MappedTo column={column(projection.sourceField)}>
                {projection.sourceObjectTypeId}
              </MappedTo>
            ),
          },
          {
            label: messages.targetField,
            value: (
              <MappedTo column={column(projection.targetField)}>
                {projection.targetObjectTypeId}
              </MappedTo>
            ),
          },
        ]}
      />
    )
  }

  if (projection._tag === "TelemetryProjectionDefinition") {
    return (
      <Facts
        items={[
          { label: messages.objectIdField, value: column(projection.objectIdField) },
          { label: messages.atField, value: column(projection.atField) },
          ...Object.entries(projection.properties).map(([property, source]) => ({
            label: property,
            value: (
              <span className="flex flex-wrap items-center gap-x-2">
                {column(source.valueField)}
                {source.unitField ? (
                  <span className="text-muted-foreground">
                    {messages.unitField(source.unitField)}
                  </span>
                ) : null}
              </span>
            ),
          })),
        ]}
      />
    )
  }

  const conflict = projection.conflictResolution
  return (
    <Facts
      items={[
        ...Object.entries(projection.properties).map(([property, source]) => ({
          label: property,
          value: column(source),
        })),
        ...Object.entries(projection.links).map(([link, source]) => ({
          label: link,
          value: (
            <MappedTo column={column(source.sourceField ?? source.sourcePropertyId ?? link)}>
              {messages.linkTarget(source.targetObjectTypeId)}
            </MappedTo>
          ),
        })),
        {
          label: messages.conflict,
          value:
            conflict.strategy === "editsWin"
              ? messages.editsWin
              : messages.mostRecent(conflict.sourceTimestamp),
        },
      ]}
    />
  )
}

function MappedTo({
  column,
  children,
}: {
  readonly column: ReactNode
  readonly children: ReactNode
}) {
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {column}
      <ArrowRight className="size-3 text-muted-foreground" />
      <span>{children}</span>
    </span>
  )
}
