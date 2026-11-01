import type { GetWorkflowResponse, GetWorkflowRunResponse } from "@sixb/client"
import {
  getWorkflowAgentNodeExecutionOptions,
  getWorkflowOptions,
  getWorkflowRunOptions,
} from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Bot, ChevronRight, Cog, Hand, Workflow, Zap } from "lucide-react"
import { type ComponentType, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AgentExecutionTrace } from "../../agent/agent-execution-trace"
import { useAppMessages } from "../../locale"
import { useSectionOpen } from "../../sections/sections"
import { workflowCanvasHref } from "../routes"
import { DetailFallback, SectionPage } from "../section-page"
import {
  FailureSummary,
  formatDuration,
  humanize,
  IconTile,
  MetaDot,
  PageSection,
  Panel,
  PanelEmpty,
  RunStatusPill,
  Stats,
  useFormat,
  useNumbers,
} from "../section-ui"
import {
  fieldRecordSchema,
  useValueTypes,
  ValuePanel,
  type ValueTypeSchemas,
  valueSchema,
  workflowRunFileLinks,
  workflowStepFileLinks,
} from "../values"
import { useWorkflowRunLiveUpdates } from "./live-updates"
import { RunLogs } from "./logs"
import { useConsoleMessages } from "./messages"
import { workflowNodeIoSchemas, workflowSchemas } from "./ontology/workflows/utils"

type Run = GetWorkflowRunResponse["run"]
type RunNode = GetWorkflowRunResponse["nodes"][number]
type WorkflowNode = GetWorkflowResponse["nodes"][number]

const nodeIcons: Record<RunNode["nodeType"], ComponentType<{ readonly className?: string }>> = {
  step: Cog,
  action: Zap,
  intervention: Hand,
  agent: Bot,
}

const noSchemas: readonly unknown[] = []

/**
 * One workflow run: how it went, what it was started with, and each step it reached with what that
 * step read and wrote. The workflow's canvas stays on the workflow's own page.
 */
export function ConsoleWorkflowRunPage() {
  const runId = useParams().runId ?? ""
  // A step left open belongs to this run; another run starts with every step closed.
  return <WorkflowRunDetail key={runId} runId={runId} />
}

function WorkflowRunDetail({ runId }: { readonly runId: string }) {
  const messages = useConsoleMessages()
  const sectionMessages = useAppMessages().sections.console
  const format = useFormat()
  useWorkflowRunLiveUpdates(runId)
  const runQuery = useQuery({ ...getWorkflowRunOptions({ path: { runId } }), retry: false })
  const run = runQuery.data?.run
  // The definition declares the run's input and each step's IO. A workflow removed since keeps its
  // runs, whose values then draw as open values.
  const workflowQuery = useQuery({
    ...getWorkflowOptions({ path: { workflowId: run?.workflowId ?? "" } }),
    enabled: Boolean(run),
    retry: false,
  })
  const workflow = workflowQuery.data
  const declared = useMemo(() => (workflow ? workflowSchemas(workflow) : noSchemas), [workflow])
  const valueTypes = useValueTypes(declared)
  // Back to the workflow, with this run drawn over its canvas.
  const back = run
    ? { href: workflowCanvasHref(run.workflowId, run.id), label: humanize(run.workflowId) }
    : { href: "/console/workflows", label: sectionMessages.pages.workflows }

  if (!run) {
    return (
      <DetailFallback
        section="console"
        page="workflows"
        back={back}
        name={runId}
        id={runId}
        icon={Workflow}
        error={runQuery.error}
      />
    )
  }

  const nodes = [...(runQuery.data?.nodes ?? [])].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  )
  const active = run.status === "queued" || run.status === "running" || run.status === "waiting"

  return (
    <SectionPage
      section="console"
      page="workflows"
      back={back}
      icon={<IconTile icon={Workflow} size="lg" />}
      title={humanize(run.workflowId)}
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
          {
            label: messages.run.took,
            value: active ? messages.run.running : formatDuration(run.startedAt, run.finishedAt),
          },
          {
            label: messages.run.queued,
            value: run.queuedAt ? format.relative(run.queuedAt) : "—",
          },
          {
            label: messages.run.finished,
            value: run.finishedAt ? format.relative(run.finishedAt) : "—",
          },
        ]}
      />

      {run.error ? (
        <PageSection title={messages.run.failed}>
          <Panel>
            <div className="px-5 py-4">
              <FailureSummary failure={run.error} />
            </div>
          </Panel>
        </PageSection>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ValuePanel
          title={messages.run.input}
          value={run.input}
          schema={workflow ? valueSchema(fieldRecordSchema(workflow.input), valueTypes) : undefined}
          fileLinks={workflowRunFileLinks(run.id, "input")}
          emptyLabel={messages.run.noInput}
        />
        <ValuePanel
          title={messages.run.output}
          value={run.output}
          fileLinks={workflowRunFileLinks(run.id, "output")}
          emptyLabel={messages.run.noOutput}
        />
      </div>

      <PageSection title={messages.run.steps} description={messages.run.stepsDescription}>
        <Panel>
          {nodes.length === 0 ? (
            <PanelEmpty icon={Cog} title={messages.run.steps} description={messages.run.noSteps} />
          ) : (
            nodes.map((node) => (
              <StepRow
                key={node.id}
                run={run}
                node={node}
                definition={workflow?.nodes.find((candidate) => candidate.id === node.nodeId)}
                valueTypes={valueTypes}
              />
            ))
          )}
        </Panel>
      </PageSection>

      <RunLogs kind="workflow" runId={run.id} />
    </SectionPage>
  )
}

function StepRow({
  run,
  node,
  definition,
  valueTypes,
}: {
  readonly run: Run
  readonly node: RunNode
  /** `undefined` once the step left the workflow's definition: its values draw as open values. */
  readonly definition: WorkflowNode | undefined
  readonly valueTypes: ValueTypeSchemas
}) {
  const messages = useConsoleMessages().run
  const workflowsOpen = useSectionOpen("console")
  // A failed or waiting step is what the reader came for, so it starts open.
  const [open, setOpen] = useState(node.status === "failed" || node.status === "waiting")
  const Icon = nodeIcons[node.nodeType]
  const io = definition ? workflowNodeIoSchemas(definition) : null
  const files = (root: "input" | "output") => workflowStepFileLinks(run.id, node.nodeKey, root)
  const isIntervention = node.nodeType === "intervention"

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
      >
        <IconTile icon={Icon} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{humanize(node.nodeKey)}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
            <span>{messages.nodeKinds[node.nodeType]}</span>
            {node.finishedAt ? (
              <>
                <MetaDot />
                <span className="tabular-nums">
                  {formatDuration(node.startedAt, node.finishedAt)}
                </span>
              </>
            ) : null}
          </span>
        </span>
        <RunStatusPill status={node.status} />
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90"
          )}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-4 border-t border-border/60 bg-muted/20 px-4 py-4">
          {node.error ? <FailureSummary failure={node.error} /> : null}
          {isIntervention && node.status === "waiting" ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              {messages.waiting}{" "}
              {workflowsOpen ? (
                <Link
                  to={workflowCanvasHref(run.workflowId, run.id, node.nodeId)}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {messages.answer}
                </Link>
              ) : null}
            </p>
          ) : null}
          {node.nodeType === "agent" ? <AgentTrace run={run} node={node} /> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            <ValuePanel
              title={messages.input}
              value={node.input}
              schema={io ? valueSchema(io.input, valueTypes) : undefined}
              fileLinks={files("input")}
              emptyLabel={messages.noInput}
            />
            <ValuePanel
              title={isIntervention ? messages.response : messages.output}
              value={node.output}
              schema={io?.output ? valueSchema(io.output, valueTypes) : undefined}
              fileLinks={files("output")}
              emptyLabel={isIntervention ? messages.noResponse : messages.noOutput}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** An agent step's model, usage and what it did, read when the step opens. */
function AgentTrace({ run, node }: { readonly run: Run; readonly node: RunNode }) {
  const messages = useConsoleMessages().run
  const numbers = useNumbers()
  const executionQuery = useQuery({
    ...getWorkflowAgentNodeExecutionOptions({ path: { runId: run.id, nodeKey: node.nodeKey } }),
    retry: false,
  })
  const summary = executionQuery.data ?? node.agentExecution
  const trace = executionQuery.data?.trace ?? []

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2.5">
        <h3 className="text-[0.8125rem] font-semibold">{messages.agentTrace}</h3>
        {summary ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">
              {messages.agentSummary(summary.modelId ?? messages.modelUnknown, summary.attempt)}
            </span>
            {summary.usage?.totalTokens === undefined ? null : (
              <>
                <MetaDot />
                <span className="tabular-nums">
                  {messages.tokens(numbers.count(summary.usage.totalTokens))}
                </span>
              </>
            )}
          </span>
        ) : null}
      </div>
      <div className="px-4 py-3.5">
        {trace.length > 0 ? (
          <AgentExecutionTrace parts={trace} variant="debug" />
        ) : (
          <p className="text-[0.8125rem] text-muted-foreground">
            {executionQuery.isPending ? messages.agentLoading : messages.agentUnavailable}
          </p>
        )}
      </div>
    </section>
  )
}
