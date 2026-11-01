import { Database, Ellipsis } from "lucide-react"
import { useSectionOpen } from "../../../../sections/sections"
import { datasetHref } from "../../../routes"
import { DatasetProducerLabel } from "../../data/producer"
import { MaybeLink, RelativeTime } from "./links"
import { useLineageMessages } from "./messages"
import {
  type DatasetLineage,
  type DatasetLineageNode,
  isExpired,
  type ProjectionSource,
  type PropertyLineage,
  upstreamSteps,
} from "./model"

type DatasetVersionRef = { readonly datasetId: string; readonly versionId: string }

import { SeparatedFacts } from "./separated"
import { ColumnName, PendingStep, TrailStep } from "./trail-step"

/** The dataset version the projection applied, then each version upstream of it, nearest first. */
export function DatasetSteps({
  applied,
  property,
  rowOrigins,
  upstream,
  pending,
}: {
  readonly applied: DatasetVersionRef
  readonly property: PropertyLineage
  readonly rowOrigins: ProjectionSource["rowOrigins"]
  readonly upstream: DatasetLineage | undefined
  readonly pending: boolean
}) {
  const messages = useLineageMessages()
  const dataOpen = useSectionOpen("console")
  // The walk starts at the applied version, which it describes in full.
  const start = upstream?.nodes[0]
  const steps = upstream ? upstreamSteps(upstream, property.origins, rowOrigins) : []
  // Where to keep walking when the walk stopped short: from the farthest version shown.
  const farthest = steps.at(-1)?.node ?? start

  return (
    <>
      <DatasetStep
        label={messages.steps.dataset}
        node={start ?? applied}
        columns={property.column ? [property.column] : []}
      />

      {pending ? <PendingStep /> : null}

      {steps.map((step) => (
        <DatasetStep
          key={`${step.node.datasetId}@${step.node.versionId}`}
          label={messages.steps.upstream}
          node={step.node}
          columns={step.columns}
        />
      ))}

      {upstream?.truncated && farthest ? (
        <TrailStep icon={Ellipsis} muted>
          <p className="text-[0.8125rem] text-muted-foreground">
            <MaybeLink
              to={dataOpen ? versionHref(farthest) : null}
              className="hover:text-foreground"
            >
              {messages.moreUpstream}
            </MaybeLink>
          </p>
        </TrailStep>
      ) : null}
    </>
  )
}

function DatasetStep({
  label,
  node,
  columns,
}: {
  readonly label: string
  /** A version as the walk describes it, or only its reference while the walk loads. */
  readonly node: DatasetLineageNode | DatasetVersionRef
  readonly columns: readonly string[]
}) {
  const messages = useLineageMessages()
  const dataOpen = useSectionOpen("console")
  const expired = isExpired(node)
  const described = "createdAt" in node ? node : null
  const href = dataOpen ? versionHref(node) : null

  // The columns the value reads and when the version was written; what wrote it, on its own line.
  const facts = [
    ...columns.map((column) => ({ key: `column:${column}`, node: <ColumnName name={column} /> })),
    ...(expired ? [{ key: "expired", node: <span>{messages.expired}</span> }] : []),
    ...(described
      ? [{ key: "createdAt", node: <RelativeTime value={described.createdAt} /> }]
      : []),
  ]

  return (
    <TrailStep icon={Database} label={label} muted={expired}>
      <p className="min-w-0 font-mono text-[0.8125rem] font-medium break-all">
        <MaybeLink to={href} title={messages.version(node.versionId)}>
          {node.datasetId}
        </MaybeLink>
      </p>

      {facts.length > 0 ? (
        <SeparatedFacts facts={facts} className="mt-1 text-[0.8125rem] text-muted-foreground" />
      ) : null}

      {described?.producer ? (
        <div className="mt-1 text-[0.8125rem]">
          <DatasetProducerLabel producer={described.producer} linked={dataOpen} />
        </div>
      ) : null}
    </TrailStep>
  )
}

/** A version's rows. An expired version is gone from the lake; its dataset opens at its latest. */
function versionHref(node: DatasetLineageNode | DatasetVersionRef): string {
  return datasetHref(node.datasetId, isExpired(node) ? undefined : node.versionId)
}
