import type { GetLakeHealthResponse } from "@sixb/client"
import { getLakeHealthOptions } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Database, HardDrive, Inbox, TriangleAlert } from "lucide-react"
import { Link } from "react-router-dom"
import { SectionPage } from "../../section-page"
import {
  apiErrorMessage,
  Facts,
  IconTile,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  PanelRow,
  PanelSkeleton,
  Pill,
  type Tone,
  useFormat,
  useNumbers,
} from "../../section-ui"
import { type DataMessages, useDataMessages } from "./messages"

type Cleanup = GetLakeHealthResponse["cleanup"]
type DatasetStorage = GetLakeHealthResponse["datasets"][number]

/** Changes that waited this long mean no flush writes them: the line turns amber. */
const STALLED_AFTER_MS = 10 * 60_000

/** Console › Lake health: how each dataset is stored, and the lake's automatic cleanup. */
export function ConsoleLakeHealthPage() {
  const messages = useDataMessages()

  return (
    <SectionPage
      section="console"
      page="lake-health"
      title={messages.lakeHealth.title}
      description={messages.lakeHealth.description}
    >
      <LakeHealth />
    </SectionPage>
  )
}

function LakeHealth() {
  const messages = useDataMessages()
  const query = useQuery({ ...getLakeHealthOptions(), retry: false })
  const health = query.data

  if (query.isPending) {
    return (
      <Panel>
        <PanelSkeleton rows={4} />
      </Panel>
    )
  }

  if (query.isError || !health) {
    return (
      <Panel>
        <PanelEmpty
          tone="error"
          icon={HardDrive}
          title={messages.lakeHealth.title}
          description={apiErrorMessage(query.error, messages.common.loadFailed)}
        />
      </Panel>
    )
  }

  if (!health.available) {
    return (
      <Panel>
        <PanelEmpty
          icon={HardDrive}
          title={messages.lakeHealth.unavailableTitle}
          description={messages.lakeHealth.unavailableDescription}
        />
      </Panel>
    )
  }

  return (
    <div className="flex flex-col gap-8">
      <CleanupSection cleanup={health.cleanup} />
      <DatasetsSection datasets={health.datasets} />
    </div>
  )
}

/** How each state reads, from what durable state says rather than from the settings. */
const CLEANUP_TONES: Record<Cleanup["state"], Tone> = {
  off: "muted",
  idle: "muted",
  "not-requested": "warn",
  "no-worker": "warn",
  failing: "error",
  cleaning: "info",
  ok: "ok",
}

function CleanupSection({ cleanup }: { readonly cleanup: Cleanup }) {
  const messages = useDataMessages().lakeHealth
  const format = useFormat()

  const when = (timestamp: string | null) =>
    timestamp === null ? messages.never : format.relative(timestamp)

  return (
    <PageSection title={messages.cleanupTitle} description={messages.cleanupDescription}>
      <Panel>
        <Facts
          items={[
            { label: messages.status, value: <CleanupState cleanup={cleanup} /> },
            { label: messages.interval, value: format.duration(cleanup.cleanupEvery) },
            { label: messages.lastRequested, value: when(cleanup.lastRequestedAt) },
            { label: messages.lastRun, value: when(cleanup.lastRunAt) },
            { label: messages.keepVersionsFor, value: format.duration(cleanup.keepVersionsFor) },
            { label: messages.deleteFilesAfter, value: format.duration(cleanup.deleteFilesAfter) },
          ]}
        />
      </Panel>
    </PageSection>
  )
}

/** The state as a pill, over what it means. */
function CleanupState({ cleanup }: { readonly cleanup: Cleanup }) {
  const { states, stateNotes } = useDataMessages().lakeHealth

  return (
    <span className="flex flex-col items-start gap-1.5">
      <Pill tone={CLEANUP_TONES[cleanup.state]}>{states[cleanup.state]}</Pill>
      <span className="text-muted-foreground">{stateNotes[cleanup.state]}</span>
    </span>
  )
}

function DatasetsSection({ datasets }: { readonly datasets: readonly DatasetStorage[] }) {
  const messages = useDataMessages().lakeHealth

  return (
    <PageSection title={messages.datasetsTitle} description={messages.datasetsDescription}>
      <Panel>
        {datasets.length === 0 ? (
          <PanelEmpty
            icon={Database}
            title={messages.emptyTitle}
            description={messages.emptyDescription}
          />
        ) : (
          datasets.map((dataset) => <DatasetRow key={dataset.datasetId} dataset={dataset} />)
        )}
      </Panel>
    </PageSection>
  )
}

/** One dataset's storage. Not a link: its warnings read under it, and its name opens it. */
function DatasetRow({ dataset }: { readonly dataset: DatasetStorage }) {
  const messages = useDataMessages().lakeHealth

  const title = (
    <>
      <Link
        to={`/console/datasets/${encodeURIComponent(dataset.datasetId)}`}
        className="truncate hover:underline"
      >
        {dataset.datasetId}
      </Link>

      {/* Beside the name rather than trailing, so the warning text below keeps the width. */}
      {dataset.warnings.length > 0 ? (
        <Pill tone="warn">{messages.warnings(dataset.warnings.length)}</Pill>
      ) : null}
    </>
  )

  return (
    <PanelRow
      leading={<IconTile icon={Database} />}
      title={title}
      meta={dataset.materialized ? <StorageFacts dataset={dataset} /> : null}
      trailing={dataset.materialized ? null : <Pill tone="muted">{messages.notWritten}</Pill>}
    >
      {dataset.ingest ? <IngestWaiting waiting={dataset.ingest} /> : null}
      <DatasetWarnings warnings={dataset.warnings} />
    </PanelRow>
  )
}

function DatasetWarnings({ warnings }: { readonly warnings: DatasetStorage["warnings"] }) {
  if (warnings.length === 0) return null

  return (
    <ul className="flex flex-col gap-1">
      {warnings.map((warning) => (
        <li
          key={warning.code}
          className="flex items-start gap-1.5 text-[0.8125rem] leading-5 text-amber-700 dark:text-amber-400"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>{warning.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** Ingested changes no flush has written yet, and how long the oldest has waited. */
function IngestWaiting({ waiting }: { readonly waiting: NonNullable<DatasetStorage["ingest"]> }) {
  const messages = useDataMessages().lakeHealth
  const numbers = useNumbers()
  const format = useFormat()
  const stalled = Date.now() - Date.parse(waiting.oldestReceivedAt) >= STALLED_AFTER_MS

  // Like a warning: one wrapping line beside its icon, so a narrow row keeps it readable.
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-[0.8125rem] leading-5",
        stalled ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
      )}
    >
      <Inbox aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        <span className="tabular-nums">
          {messages.waiting(waiting.pendingChanges, numbers.count(waiting.pendingChanges))}
        </span>
        {" · "}
        <span>{messages.oldest(format.relative(waiting.oldestReceivedAt))}</span>
      </span>
    </p>
  )
}

/** Rows, files and history, leaving out what is at zero beyond the files themselves. */
function StorageFacts({ dataset }: { readonly dataset: DatasetStorage }) {
  const messages = useDataMessages()
  const numbers = useNumbers()
  const facts = storageFacts(dataset, messages, numbers)

  return (
    <>
      {facts.map((fact, index) => (
        <span key={fact} className="contents">
          {index > 0 ? <MetaDot /> : null}
          <span className="tabular-nums">{fact}</span>
        </span>
      ))}
    </>
  )
}

function storageFacts(
  dataset: DatasetStorage,
  messages: DataMessages,
  numbers: ReturnType<typeof useNumbers>
): string[] {
  const lake = messages.lakeHealth
  const count = numbers.count

  const files = lake.files(dataset.dataFiles, count(dataset.dataFiles))
  const facts = [
    messages.common.rows(dataset.rowCount, count(dataset.rowCount)),
    dataset.smallDataFiles > 0
      ? `${files} (${lake.smallFiles(dataset.smallDataFiles, count(dataset.smallDataFiles))})`
      : files,
    numbers.bytes(dataset.dataBytes),
  ]

  if (dataset.deleteFiles > 0) {
    facts.push(lake.deleteFiles(dataset.deleteFiles, count(dataset.deleteFiles)))
  }
  if (dataset.inlinedRows > 0) {
    facts.push(lake.inlinedRows(dataset.inlinedRows, count(dataset.inlinedRows)))
  }
  facts.push(lake.snapshots(dataset.retainedSnapshots, count(dataset.retainedSnapshots)))
  if (dataset.partitionBy.length > 0) {
    facts.push(lake.partitionedBy(dataset.partitionBy.join(", ")))
  }

  return facts
}
