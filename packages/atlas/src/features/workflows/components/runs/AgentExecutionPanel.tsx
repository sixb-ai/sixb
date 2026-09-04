import { AgentExecutionTrace } from "@sixb/agent-ui"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ScrollText } from "lucide-react"
import type { ReactNode } from "react"
import { SixbFailureSummary } from "../../../../components/SixbFailureSummary"
import { type FileLinkForPath, StructuredValue } from "../../../../components/StructuredValue"
import {
  formatDate,
  type WorkflowAgentNodeExecution,
  type WorkflowRunNode,
} from "../../utils/workflows"
import { RunDebugSection, RunMetadataRows, stringifyRunDebugValue } from "./RunDebugSection"

export function AgentExecutionPanel({
  summary,
  execution,
  nodeInput,
  nodeOutput,
  nodeError,
  inputFileLinkForPath,
  outputFileLinkForPath,
  loading,
  failed,
}: {
  summary: WorkflowRunNode["agentExecution"]
  execution: WorkflowAgentNodeExecution | undefined
  nodeInput: WorkflowRunNode["input"]
  nodeOutput: WorkflowRunNode["output"]
  nodeError: WorkflowRunNode["error"]
  inputFileLinkForPath: FileLinkForPath
  outputFileLinkForPath: FileLinkForPath
  loading: boolean
  failed: boolean
}) {
  const data = execution ?? summary
  const trace = execution?.trace ?? []
  const stepMarkers = trace.filter((part) => part.type === "step-start").length
  const stepCount = stepMarkers > 0 ? stepMarkers : trace.length > 0 ? 1 : 0
  const tools = trace.filter((part) => part.type === "tool-call")
  const failedTools = tools.filter((part) => part.state === "output-error").length
  const failure = execution?.error ?? nodeError
  const finalAnswer = finalAgentAnswer(trace)

  if (!data) {
    if (loading) return <p className="text-xs text-muted-foreground">Loading agent execution...</p>
    if (failed) return <p className="text-xs text-destructive">Could not load agent execution.</p>
    return <p className="text-xs text-muted-foreground">No agent execution record.</p>
  }

  return (
    <div className="space-y-4">
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium text-foreground">Agent task</p>
            <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">
              {data.modelId ?? "Model not reported"} · Attempt {data.attempt}
            </p>
          </div>
          <AgentExecutionStatus status={data.status} />
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {data.usage?.totalTokens === undefined ? null : (
            <span>{formatTokenCount(data.usage.totalTokens)} tokens</span>
          )}
          {data.cost ? (
            <>
              <span>{formatAiCostAmounts(data.cost.amounts)} recorded cost</span>
              <span>{formatAiCostCoverage(data.cost)}</span>
            </>
          ) : null}
          {execution ? (
            <>
              <span>{pluralCount(stepCount, "model step")}</span>
              <span>{pluralCount(tools.length, "tool call")}</span>
              {failedTools > 0 ? (
                <span className="font-medium text-destructive">
                  {pluralCount(failedTools, "tool error")}
                </span>
              ) : null}
            </>
          ) : loading ? (
            <span>Loading trace…</span>
          ) : null}
        </div>
      </div>

      {failure ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
            {execution?.failurePhase === "structured-finalizer"
              ? "Failed during structured output"
              : execution?.failurePhase === "agent-loop"
                ? "Failed during agent work"
                : "Execution failed"}
          </p>
          <SixbFailureSummary failure={failure} className="text-sm" />
        </div>
      ) : null}

      <Tabs defaultValue="trace" className="gap-3">
        <TabsList variant="line" className="h-9 w-full border-b border-border/70">
          <TabsTrigger value="trace">Trace</TabsTrigger>
          <TabsTrigger value="io">Input & output</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        <TabsContent value="trace" className="mt-0">
          {trace.length > 0 ? (
            <AgentExecutionTrace parts={trace} variant="debug" />
          ) : loading ? (
            <AgentDebugEmpty>Loading completed agent steps...</AgentDebugEmpty>
          ) : failed ? (
            <AgentDebugEmpty error>Could not load the agent trace.</AgentDebugEmpty>
          ) : (
            <AgentDebugEmpty>
              {data.status === "running"
                ? "No completed steps yet."
                : "No agent work was captured."}
            </AgentDebugEmpty>
          )}
        </TabsContent>

        <TabsContent value="io" className="mt-0 space-y-5">
          <RunDebugSection label="Workflow input">
            <StructuredValue
              value={nodeInput}
              emptyLabel="No input"
              fileLinkForPath={inputFileLinkForPath}
              variant="debug"
            />
          </RunDebugSection>
          <RunDebugSection
            label="Resolved prompt"
            copyValue={execution?.prompt}
            copyLabel="Copy resolved prompt"
          >
            {execution?.prompt ? (
              <DebugTextValue value={execution.prompt} />
            ) : (
              <AgentDebugEmpty>Prompt not available.</AgentDebugEmpty>
            )}
          </RunDebugSection>
          <RunDebugSection
            label="Agent answer"
            copyValue={finalAnswer}
            copyLabel="Copy agent answer"
          >
            {finalAnswer ? (
              <DebugTextValue value={finalAnswer} />
            ) : (
              <AgentDebugEmpty>No final agent answer was captured.</AgentDebugEmpty>
            )}
          </RunDebugSection>
          <RunDebugSection label="Structured output">
            <StructuredValue
              value={nodeOutput ?? null}
              emptyLabel="No structured output"
              fileLinkForPath={outputFileLinkForPath}
              variant="debug"
            />
          </RunDebugSection>
        </TabsContent>

        <TabsContent value="details" className="mt-0 space-y-5">
          <AgentExecutionMetadata data={data} execution={execution} />
          <AgentUsageDetails usage={data.usage} />
          {execution?.diagnostics?.length ? (
            <RunDebugSection label="Diagnostics">
              <StructuredValue value={execution.diagnostics} variant="debug" />
            </RunDebugSection>
          ) : null}
          {execution ? <RawExecutionRecord execution={execution} /> : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function AgentExecutionStatus({ status }: { status: WorkflowAgentNodeExecution["status"] }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize",
        status === "succeeded" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        status === "failed" && "border-destructive/30 bg-destructive/10 text-destructive",
        status === "cancelled" && "border-border bg-muted text-muted-foreground",
        (status === "running" || status === "queued") &&
          "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      )}
    >
      {status}
    </span>
  )
}

function AgentDebugEmpty({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p className={cn("text-xs text-muted-foreground", error && "text-destructive")}>{children}</p>
  )
}

function DebugTextValue({ value }: { value: string }) {
  return (
    <pre className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
      {value}
    </pre>
  )
}

function AgentExecutionMetadata({
  data,
  execution,
}: {
  data: NonNullable<WorkflowRunNode["agentExecution"]>
  execution: WorkflowAgentNodeExecution | undefined
}) {
  const rows = [
    ["Finish reason", execution?.finishReason ?? data.finishReason ?? "Not reported"],
    ["Started", formatDate(data.startedAt)],
    ["Completed", formatDate(data.completedAt)],
    ["Node run ID", execution?.nodeRunId ?? "Not loaded"],
  ] as const

  return (
    <RunDebugSection label="Execution">
      <RunMetadataRows rows={rows} />
    </RunDebugSection>
  )
}

function AgentUsageDetails({
  usage,
}: {
  usage: NonNullable<WorkflowRunNode["agentExecution"]>["usage"]
}) {
  if (!usage) {
    return (
      <RunDebugSection label="Token usage">
        <AgentDebugEmpty>No token usage was reported.</AgentDebugEmpty>
      </RunDebugSection>
    )
  }
  const values = [
    ["Total", usage.totalTokens],
    ["Input", usage.inputTokens],
    ["Output", usage.outputTokens],
    ["Uncached input", usage.uncachedInputTokens],
    ["Cache read", usage.cacheReadInputTokens],
    ["Cache write", usage.cacheWriteInputTokens],
    ["Text output", usage.textOutputTokens],
    ["Reasoning output", usage.reasoningOutputTokens],
  ] as const

  return (
    <RunDebugSection label="Token usage">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {values.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <p className="text-[10px] text-muted-foreground">{label}</p>
            <p className="mt-0.5 font-mono text-xs tabular-nums text-foreground">
              {value === undefined ? "—" : formatTokenCount(value)}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Reporting status:{" "}
        <span className="font-medium text-foreground">{usage.reportingStatus}</span>
      </p>
    </RunDebugSection>
  )
}

function RawExecutionRecord({ execution }: { execution: WorkflowAgentNodeExecution }) {
  const raw = stringifyRunDebugValue(execution)
  return (
    <RunDebugSection label="Raw execution record" copyValue={raw} copyLabel="Copy raw execution">
      <details>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ScrollText className="size-3.5" /> View exact API response
        </summary>
        <pre className="scrollbar-thin mt-3 max-h-96 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground">
          {raw}
        </pre>
      </details>
    </RunDebugSection>
  )
}

function finalAgentAnswer(
  trace: readonly NonNullable<WorkflowAgentNodeExecution["trace"]>[number][]
) {
  let finalStepStart = -1
  for (let index = 0; index < trace.length; index += 1) {
    if (trace[index]?.type === "step-start") finalStepStart = index
  }
  const finalStep = trace.slice(finalStepStart + 1)
  if (finalStep.some((part) => part.type === "tool-call")) return undefined
  const answer = finalStep
    .filter(
      (part): part is Extract<(typeof trace)[number], { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("")
    .trim()
  return answer || undefined
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? "—" : new Intl.NumberFormat().format(value)
}

function formatAiCostAmounts(
  amounts: readonly { currency: string; amountNanos: string }[]
): string {
  if (amounts.length === 0) return "—"
  return amounts
    .map((amount) => {
      const nanos = BigInt(amount.amountNanos)
      const whole = nanos / 1_000_000_000n
      const fraction = (nanos % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "")
      return `${amount.currency} ${whole.toLocaleString("en-US")}${fraction ? `.${fraction.padEnd(2, "0")}` : ".00"}`
    })
    .join(" · ")
}

function formatAiCostCoverage(cost: {
  reportedCallCount: number
  ratedCallCount: number
  unpriceableCallCount: number
  unvaluedCallCount: number
}): string {
  const valued = cost.reportedCallCount + cost.ratedCallCount
  const missing = cost.unpriceableCallCount + cost.unvaluedCallCount
  if (valued === 0 && missing === 0) return "No model calls"
  const sources = `${cost.reportedCallCount} reported · ${cost.ratedCallCount} estimated`
  return missing === 0 ? sources : `${sources} · ${missing} missing`
}

function pluralCount(value: number, singular: string): string {
  return `${value} ${value === 1 ? singular : `${singular}s`}`
}
