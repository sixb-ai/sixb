import type { GetLakeHealthResponse } from "@sixb/client"
import { getLakeHealthOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Database, HardDrive, TriangleAlert } from "lucide-react"
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

/** Console › Lake health: how each dataset is stored, and the lake's automatic cleanup. */
export function ConsoleLakeHealthPage() {
  const messages = useDataMessages()
  const healthQuery = useQuery({ ...getLakeHealthOptions(), retry: false })
  const health = healthQuery.data

  return (
    <SectionPage
      section="console"
      page="lake-health"
      title={messages.lakeHealth.title}
      description={messages.lakeHealth.description}
    >
      {healthQuery.isPending ? (
        <Panel>
          <PanelSkeleton rows={4} />
        </Panel>
      ) : healthQuery.isError || !health ? (
        <Panel>
          <PanelEmpty
            tone="error"
            icon={HardDrive}
            title={messages.lakeHealth.title}
            description={apiErrorMessage(healthQuery.error, messages.common.loadFailed)}
          />
        </Panel>
      ) : !health.available ? (
        <Panel>
          <PanelEmpty
            icon={HardDrive}
            title={messages.lakeHealth.unavailableTitle}
            description={messages.lakeHealth.unavailableDescription}
          />
        </Panel>
      ) : (
        <div className="flex flex-col gap-8">
          <CleanupSection cleanup={health.cleanup} />
          <DatasetsSection datasets={health.datasets} />
        </div>
      )}
    </SectionPage>
  )
}

/** How each state reads, from what durable state says rather than from the settings. */
const CLEANUP_TONES: Record<Cleanup["state"], Tone> = {
  off: "muted",
  idle: "muted",
  "not-requested": "warn",
  "no-worker": "warn",
  failing: "error",
  running: "ok",
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
            { label: messages.lastRequested, value: when(cleanup.requestedAt) },
            { label: messages.lastRun, value: when(cleanup.lastRunAt) },
            { label: messages.keepVersionsFor, value: cleanup.keepVersionsFor },
            { label: messages.deleteFilesAfter, value: cleanup.deleteFilesAfter },
          ]}
        />
      </Panel>
    </PageSection>
  )
}

/** The state as a pill, over what it means. */
function CleanupState({ cleanup }: { readonly cleanup: Cleanup }) {
  const { states, stateNotes, on } = useDataMessages().lakeHealth

  return (
    <span className="flex flex-col items-start gap-1.5">
      <Pill tone={CLEANUP_TONES[cleanup.state]}>
        {cleanup.state === "running" ? on(cleanup.cleanupEvery) : states[cleanup.state]}
      </Pill>
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
  const messages = useDataMessages()

  return (
    <PanelRow
      leading={<IconTile icon={Database} />}
      title={
        <>
          <Link
            to={`/console/datasets/${encodeURIComponent(dataset.datasetId)}`}
            className="truncate hover:underline"
          >
            {dataset.datasetId}
          </Link>
          {/* Beside the name rather than trailing, so the warning text below keeps the width. */}
          {dataset.warnings.length > 0 ? (
            <Pill tone="warn">{messages.lakeHealth.warnings(dataset.warnings.length)}</Pill>
          ) : null}
        </>
      }
      meta={dataset.materialized ? <StorageFacts dataset={dataset} /> : null}
      trailing={
        dataset.materialized ? null : <Pill tone="muted">{messages.lakeHealth.notWritten}</Pill>
      }
    >
      {dataset.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {dataset.warnings.map((warning) => (
            <li
              key={warning.code}
              className="flex items-start gap-1.5 text-[0.8125rem] leading-5 text-amber-700 dark:text-amber-400"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </PanelRow>
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
      ? `${files} (${lake.smallFiles(count(dataset.smallDataFiles))})`
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
