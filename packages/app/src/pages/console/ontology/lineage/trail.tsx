import { Activity, ArrowRight, EyeOff, Layers, PencilLine } from "lucide-react"
import { Link } from "react-router-dom"
import { useSectionOpen } from "../../../../sections/sections"
import { actionRunHref, projectionHref, workflowRunHref } from "../../../routes"
import { humanize, MetaDot, useFormat } from "../../../section-ui"
import { type FileLinksAt, type ValueSchema, ValueTree } from "../../../values"
import { useActionName } from "./action-name"
import { DatasetSteps } from "./dataset-steps"
import { MaybeLink, RelativeTime } from "./links"
import { useLineageMessages } from "./messages"
import {
  type DatasetLineage,
  type EditSource,
  type ExplainedProperty,
  hiddenSteps,
  type ObjectLineage,
  type ProjectionSource,
  type PropertyLineage,
  projectionOpens,
  resolutionOf,
  type TelemetrySource,
  telemetryProjection,
} from "./model"
import { RequesterLine, useRequesterName } from "./requester"
import { TrailStep } from "./trail-step"

/** How the property's own values draw: its schema, and links to the files it holds. */
export interface ValueDisplay {
  readonly schema?: ValueSchema
  readonly fileLinks?: FileLinksAt
}

/**
 * Where one property's value comes from, nearest first: the source that decided it, then for an
 * imported value the dataset version the projection applied and the versions upstream of it. The
 * deciding step is the filled one. Steps the reader cannot see close the trail as a count.
 */
export function PropertyTrail({
  lineage,
  explained,
  upstream,
  upstreamPending,
  display,
}: {
  readonly lineage: ObjectLineage
  readonly explained: ExplainedProperty
  /** The walk upstream of the applied dataset version, for an imported value. */
  readonly upstream: DatasetLineage | undefined
  readonly upstreamPending: boolean
  readonly display: ValueDisplay
}) {
  const messages = useLineageMessages()
  const { property, source } = explained
  const hidden = hiddenSteps(explained, upstream)

  return (
    <ol className="flex flex-col">
      {source.kind === "edit" ? (
        <EditStep lineage={lineage} explained={explained} source={source} display={display} />
      ) : null}

      {source.kind === "telemetry" ? <TelemetryStep property={property} source={source} /> : null}

      {source.kind === "projection" ? (
        <>
          <ProjectionStep
            lineage={lineage}
            explained={explained}
            source={source}
            display={display}
          />
          {source.datasetVersion ? (
            <DatasetSteps
              applied={source.datasetVersion}
              property={property}
              rowOrigins={source.rowOrigins}
              upstream={upstream}
              pending={upstreamPending}
            />
          ) : null}
        </>
      ) : null}

      {hidden > 0 ? (
        <TrailStep icon={EyeOff} muted>
          <p className="text-[0.8125rem] text-muted-foreground">{messages.restricted(hidden)}</p>
        </TrailStep>
      ) : null}
    </ol>
  )
}

function EditStep({
  lineage,
  explained,
  source,
  display,
}: {
  readonly lineage: ObjectLineage
  readonly explained: ExplainedProperty
  readonly source: EditSource
  readonly display: ValueDisplay
}) {
  const messages = useLineageMessages()
  const observabilityOpen = useSectionOpen("console")
  const actionName = useActionName(source.action?.actionId)
  const editor = describeEditor(source, actionName, messages.edit)
  const run = observabilityOpen ? editor.run : null

  return (
    <TrailStep
      icon={PencilLine}
      emphasis
      label={
        <>
          {messages.steps.edit}
          <MetaDot />
          <RelativeTime value={source.committedAt} />
        </>
      }
    >
      <p className="text-sm font-medium">{editor.title}</p>
      {source.commitId === null ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{messages.edit.commitUnknown}</p>
      ) : null}

      {source.requestedBy ? (
        <div className="mt-1.5 text-[0.8125rem]">
          <RequesterLine requester={source.requestedBy} />
        </div>
      ) : null}

      <Replaced lineage={lineage} replaced={explained.property.replaced} display={display} />
      <ResolutionNote lineage={lineage} explained={explained} />

      {run ? (
        <Link
          to={run.href}
          className="mt-3 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground"
        >
          {run.label}
          <ArrowRight className="size-3" />
        </Link>
      ) : null}
    </TrailStep>
  )
}

/**
 * What made an edit: the Action, the workflow or other primitive it ran in, the agent, or a direct
 * write from a request. An edit whose writer the reader may not see, or that names none, is only
 * an edit.
 */
function describeEditor(
  source: EditSource,
  actionName: string | null,
  messages: ReturnType<typeof useLineageMessages>["edit"]
): {
  readonly title: string
  readonly run: { readonly href: string; readonly label: string } | null
} {
  if (source.action) {
    return {
      title: actionName ?? humanize(source.action.actionId),
      run: { href: actionRunHref(source.action.runId), label: messages.viewActionRun },
    }
  }

  const executor = source.executor
  if (executor?.type === "primitive") {
    return {
      title: humanize(executor.id),
      run:
        executor.kind === "workflow"
          ? { href: workflowRunHref(executor.runId), label: messages.viewWorkflowRun }
          : null,
    }
  }

  const title =
    executor?.type === "agent"
      ? messages.agent
      : executor?.type === "request"
        ? messages.direct
        : messages.generic

  return { title, run: null }
}

function ProjectionStep({
  lineage,
  explained,
  source,
  display,
}: {
  readonly lineage: ObjectLineage
  readonly explained: ExplainedProperty
  readonly source: ProjectionSource
  readonly display: ValueDisplay
}) {
  const messages = useLineageMessages()
  const dataOpen = useSectionOpen("console")

  return (
    <TrailStep icon={Layers} emphasis label={messages.steps.projection}>
      <p className="text-sm font-medium">
        <MaybeLink
          to={dataOpen && projectionOpens(source) ? projectionHref(source.projectionId) : null}
        >
          {humanize(source.projectionId)}
        </MaybeLink>
      </p>

      <Replaced lineage={lineage} replaced={explained.property.replaced} display={display} />
      <ResolutionNote lineage={lineage} explained={explained} />
    </TrailStep>
  )
}

function TelemetryStep({
  property,
  source,
}: {
  readonly property: PropertyLineage
  readonly source: TelemetrySource
}) {
  const messages = useLineageMessages()
  const format = useFormat()
  const dataOpen = useSectionOpen("console")
  const at = property.at ?? source.committedAt
  const opens = dataOpen && telemetryProjection(source) !== null

  return (
    <TrailStep icon={Activity} emphasis label={messages.steps.telemetry}>
      <p className="text-sm font-medium">
        <time dateTime={at} title={format.dateTime(at)}>
          {messages.observed(format.relative(at))}
        </time>
      </p>

      <p className="mt-1 text-[0.8125rem] text-muted-foreground">
        {source.projectionId ? (
          <>
            {messages.telemetryFrom}{" "}
            <MaybeLink
              to={opens ? projectionHref(source.projectionId) : null}
              className="text-foreground"
            >
              {humanize(source.projectionId)}
            </MaybeLink>
          </>
        ) : (
          messages.appendedDirectly
        )}
      </p>
    </TrailStep>
  )
}

/** The value the deciding source won over, struck through, and where that value came from. */
function Replaced({
  lineage,
  replaced,
  display,
}: {
  readonly lineage: ObjectLineage
  readonly replaced: PropertyLineage["replaced"]
  readonly display: ValueDisplay
}) {
  const messages = useLineageMessages().replaced
  const source = replaced ? lineage.sources[replaced.source] : undefined
  if (!replaced || !source) return null

  return (
    <div className="mt-3 rounded-lg bg-muted/60 px-3 py-2.5 text-[0.8125rem]">
      <p className="text-xs text-muted-foreground">{messages.label}</p>
      <del className="mt-1 block text-muted-foreground decoration-muted-foreground/70">
        {replaced.value === undefined ? (
          messages.noValue
        ) : (
          <ValueTree value={replaced.value} schema={display.schema} />
        )}
      </del>
      <ReplacedSource source={source} />
    </div>
  )
}

function ReplacedSource({ source }: { readonly source: ObjectLineage["sources"][string] }) {
  const messages = useLineageMessages().replaced
  const format = useFormat()
  const dataOpen = useSectionOpen("console")
  const requester = useRequesterName(source.kind === "edit" ? source.requestedBy : undefined)

  if (source.kind === "projection") {
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {messages.importedFrom}{" "}
        <MaybeLink
          to={dataOpen && projectionOpens(source) ? projectionHref(source.projectionId) : null}
          className="text-foreground"
        >
          {humanize(source.projectionId)}
        </MaybeLink>
      </p>
    )
  }

  if (source.kind === "edit") {
    const when = format.relative(source.committedAt)
    return (
      <p className="mt-1 text-xs text-muted-foreground" title={format.dateTime(source.committedAt)}>
        {requester ? messages.editedBy(requester, when) : messages.edited(when)}
      </p>
    )
  }

  return null
}

/** Why the deciding source won, in one sentence, when the newer of the two candidates wins. */
function ResolutionNote({
  lineage,
  explained,
}: {
  readonly lineage: ObjectLineage
  readonly explained: ExplainedProperty
}) {
  const messages = useLineageMessages().resolution
  const resolution = resolutionOf(lineage, explained)
  const requester = useRequesterName(
    resolution?.winner === "source" ? resolution.edit?.requestedBy : undefined
  )
  if (!resolution) return null

  const sentence =
    resolution.winner === "edit"
      ? resolution.projectionId
        ? messages.editNewer(humanize(resolution.projectionId))
        : messages.editNewerThanSource
      : requester
        ? messages.sourceNewer(requester)
        : messages.sourceNewerThanEdit

  return <p className="mt-2.5 text-[0.8125rem] leading-5 text-muted-foreground">{sentence}</p>
}
