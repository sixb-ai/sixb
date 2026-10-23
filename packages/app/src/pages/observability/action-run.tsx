import type { GetActionRunResponse } from "@sixb/client"
import { getActionRunOptions, listActionsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { CircleHelp, Loader2, Zap } from "lucide-react"
import { useEffect, useMemo, useReducer } from "react"
import { useParams } from "react-router-dom"
import { DetailFallback, SectionPage } from "../section-page"
import {
  FailureSummary,
  formatDuration,
  humanize,
  IconTile,
  PageSection,
  Panel,
  RunStatusPill,
  Stats,
  useFormat,
} from "../section-ui"
import {
  actionRunFileLinks,
  fieldRecordSchema,
  useValueTypes,
  ValuePanel,
  valueSchema,
} from "../values"
import { RunLogs } from "./logs"
import { useObservabilityMessages } from "./messages"

type ActionRun = GetActionRunResponse

/** How long after a run ends its effects can still land: their 30-second deadline and a margin. */
export const effectsOutcomeWaitMs = 60_000
/** A run whose effects have not ended is read again this often: effects record no event. */
const effectsPollMs = 1_000

type EffectsState = "none" | "pending" | "unrecorded" | "recorded"

/**
 * Where a run's effects stand. A run is recorded when it ends and its effects run after that, so a
 * run that committed and has effects stays in its commit phase until their outcome lands.
 */
export function effectsState(
  run: Pick<ActionRun, "effects" | "status" | "phase" | "finishedAt">,
  hasEffects: boolean | undefined,
  now = Date.now()
): EffectsState {
  if (run.effects) return "recorded"
  if (run.status !== "succeeded" || run.phase !== "commit" || !hasEffects) return "none"
  return now - Date.parse(run.finishedAt) < effectsOutcomeWaitMs ? "pending" : "unrecorded"
}

/**
 * How long from `now` a pending effects outcome is still waited for. Nothing on the page changes
 * when the wait ends, so whoever shows the state draws again then.
 */
export function effectsWaitRemainingMs(
  run: Pick<ActionRun, "finishedAt">,
  now = Date.now()
): number {
  return Math.max(0, Date.parse(run.finishedAt) + effectsOutcomeWaitMs - now)
}

const noSchemas: readonly unknown[] = []

/** One action run: what it was asked, how far it got, and what it wrote back and set off. */
export function ObservabilityActionRunPage() {
  const messages = useObservabilityMessages()
  const format = useFormat()
  const runId = useParams().runId ?? ""
  const actionsQuery = useQuery({ ...listActionsOptions(), retry: false })
  const runQuery = useQuery({
    ...getActionRunOptions({ path: { runId } }),
    retry: false,
    refetchInterval: (query) => {
      const run = query.state.data
      const action = actionsQuery.data?.find((candidate) => candidate.id === run?.actionId)
      return run && effectsState(run, action?.phases.effects) === "pending" ? effectsPollMs : false
    },
  })
  const run = runQuery.data
  // Params are declared by the action. A run whose action is gone has no schema left, so its
  // params draw as open values.
  const action = actionsQuery.data?.find((candidate) => candidate.id === run?.actionId)
  const paramSchemas = useMemo(
    () => (action ? action.params.map((param) => param.schema) : noSchemas),
    [action]
  )
  const valueTypes = useValueTypes(paramSchemas)
  const back = { href: "/observability/runs?kind=actions", label: messages.runs.title }

  if (!run) {
    return (
      <DetailFallback
        section="observability"
        page="runs"
        back={back}
        name={runId}
        id={runId}
        icon={Zap}
        error={runQuery.error}
      />
    )
  }

  return (
    <SectionPage
      section="observability"
      page="runs"
      back={back}
      icon={<IconTile icon={Zap} size="lg" />}
      title={humanize(run.actionId)}
      meta={
        <>
          <RunStatusPill status={run.status} />
          <span className="font-mono text-xs">{run.id}</span>
        </>
      }
    >
      <Stats
        items={[
          {
            label: messages.run.started,
            value: (
              <span title={format.dateTime(run.startedAt)}>{format.relative(run.startedAt)}</span>
            ),
          },
          { label: messages.run.took, value: formatDuration(run.startedAt, run.finishedAt) },
          {
            label: messages.action.phase,
            value: messages.action.phaseNames[run.phase],
          },
          {
            label: messages.action.subject,
            value:
              run.subject.kind === "none" ? (
                <span className="text-muted-foreground">{messages.runs.noSubject}</span>
              ) : (
                <span className="font-mono text-xs" title={run.subject.primaryId}>
                  {run.subject.objectTypeId} · {run.subject.primaryId}
                </span>
              ),
          },
        ]}
      />

      {run.error ? (
        <PageSection
          title={
            run.error.code === "action.rejected"
              ? messages.action.rejected
              : messages.action.failedIn(messages.action.phases[run.error.details.phase])
          }
        >
          <Panel>
            <div className="px-5 py-4">
              <FailureSummary failure={run.error} />
            </div>
          </Panel>
        </PageSection>
      ) : null}

      <ValuePanel
        title={messages.action.params}
        value={run.params}
        schema={
          action
            ? valueSchema(
                fieldRecordSchema(
                  Object.fromEntries(action.params.map((param) => [param.id, param]))
                ),
                valueTypes
              )
            : undefined
        }
        fileLinks={actionRunFileLinks(run.id, "params")}
      />

      {/* What the handler returned: nothing declares it, so it draws as an open value. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ValuePanel
          title={messages.action.writeback}
          value={run.writeback}
          fileLinks={actionRunFileLinks(run.id, "writeback")}
          emptyLabel={messages.action.noWriteback}
        />
        <Effects run={run} hasEffects={action?.phases.effects} />
      </div>

      <RunLogs kind="action" runId={run.id} />
    </SectionPage>
  )
}

function Effects({
  run,
  hasEffects,
}: {
  readonly run: ActionRun
  readonly hasEffects: boolean | undefined
}) {
  const messages = useObservabilityMessages().action
  const now = Date.now()
  const state = effectsState(run, hasEffects, now)
  // The wait ends on the clock alone: the last poll returns the same run and nothing else would
  // draw the page again, so a timer does.
  const waitMs = state === "pending" ? effectsWaitRemainingMs(run, now) : null
  const [, renderAgain] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    if (waitMs === null) return
    const timer = setTimeout(renderAgain, waitMs)
    return () => clearTimeout(timer)
  }, [waitMs])

  if (state === "pending" || state === "unrecorded") {
    const Icon = state === "pending" ? Loader2 : CircleHelp
    return (
      <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
        <div className="flex h-11 items-center border-b border-border px-4">
          <h3 className="text-[0.8125rem] font-semibold">{messages.effects}</h3>
        </div>
        <p className="flex items-start gap-2 px-4 py-3.5 text-[0.8125rem] text-muted-foreground">
          <Icon
            className={
              state === "pending" ? "mt-0.5 size-4 shrink-0 animate-spin" : "mt-0.5 size-4 shrink-0"
            }
          />
          {state === "pending" ? messages.effectsPending : messages.effectsUnrecorded}
        </p>
      </section>
    )
  }
  return <ValuePanel title={messages.effects} value={run.effects} emptyLabel={messages.noEffects} />
}
