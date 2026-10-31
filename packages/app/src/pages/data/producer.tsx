import type { GetDatasetVersionResponse } from "@sixb/client"
import { RefreshCw, Workflow } from "lucide-react"
import type { ComponentType } from "react"
import { Link } from "react-router-dom"
import { datasetHref, pipelineHref, syncHref } from "../routes"
import { humanize } from "../section-ui"
import { useDataMessages } from "./messages"

export type DatasetProducer = NonNullable<GetDatasetVersionResponse["producer"]>

/**
 * What wrote a dataset version: its sync, or its pipeline at the run that wrote it. A producer whose
 * runs the reader may not view arrives as its kind alone, and reads as "A sync" without a link.
 * `linked` is off where the Data pages are closed to the reader.
 */
export function DatasetProducerLabel({
  producer,
  linked = true,
}: {
  readonly producer: DatasetProducer
  readonly linked?: boolean
}) {
  const messages = useDataMessages().datasets.producer

  if (producer.kind === "ingest") {
    return <span className="text-muted-foreground">{messages.ingest}</span>
  }

  if (!producer.id) {
    return <span className="text-muted-foreground">{messages.hidden[producer.kind]}</span>
  }

  const href =
    producer.kind === "sync" ? syncHref(producer.id) : pipelineHref(producer.id, producer.runId)

  // The pipeline's step reads under its name, so a narrow column never strands a separator.
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <ProducerIcon icon={producer.kind === "sync" ? RefreshCw : Workflow} />
      <span className="min-w-0">
        {linked ? (
          <Link to={href} className="break-words underline-offset-2 hover:underline">
            {humanize(producer.id)}
          </Link>
        ) : (
          <span className="break-words">{humanize(producer.id)}</span>
        )}
        {producer.stepId ? (
          <span className="block break-words text-muted-foreground">
            {humanize(producer.stepId)}
          </span>
        ) : null}
      </span>
    </span>
  )
}

/** The dataset versions one version was computed from, each opening that dataset at that version. */
export function DatasetVersionInputs({
  inputs,
}: {
  readonly inputs: readonly { readonly datasetId: string; readonly versionId: string }[]
}) {
  return (
    <span className="flex flex-col gap-1">
      {inputs.map((input) => (
        <Link
          key={`${input.datasetId}@${input.versionId}`}
          to={datasetHref(input.datasetId, input.versionId)}
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 underline-offset-2 hover:underline"
        >
          <span className="min-w-0 font-mono text-xs break-all">{input.datasetId}</span>
          <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">
            {shortVersionId(input.versionId)}
          </span>
        </Link>
      ))}
    </span>
  )
}

/** A version id short enough for a list, as the version picker shows it. */
export function shortVersionId(versionId: string): string {
  return versionId.slice(0, 12)
}

function ProducerIcon({ icon: Icon }: { readonly icon: ComponentType<{ className?: string }> }) {
  // Centered on the name's first line.
  return <Icon aria-hidden className="mt-[0.1875rem] size-3.5 shrink-0 text-muted-foreground" />
}
