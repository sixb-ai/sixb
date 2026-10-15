import type {
  ListAiModelCallGroupsResponse,
  ListAiModelCallsData,
  ListAiModelCallsResponse,
} from "@sixb/client"
import { listAiModelCallsOptions } from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, Bot, ChevronRight, GitBranch, Layers, Workflow, Zap } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Link } from "react-router-dom"
import { PageSection, Panel, Pill, type Tone } from "../../section-ui"
import { actionRunHref, workflowRunHref } from "../runs"
import { formatMoney } from "./format"
import { type AiUsageMessages, useAiUsageMessages } from "./messages"

type Group = ListAiModelCallGroupsResponse["items"][number]
type Execution = Group["executions"][number]
type ModelCall = ListAiModelCallsResponse["items"][number]
export type CallFilters = Omit<ListAiModelCallsData["query"], "executionId" | "offset" | "limit">

export const callsPageSize = 25

const grid =
  "grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-x-4 md:grid-cols-[minmax(0,1fr)_10rem_4rem_8rem_8rem_9rem]"

/**
 * The model calls behind the charts, by execution: an agent's conversation, a workflow run, an
 * action run. An execution that delegated to sub-agents opens onto each, then onto their calls.
 */
export function ModelCalls({
  data,
  filters,
  loading,
  error,
  offset,
  filterControl,
  onPrevious,
  onNext,
  onRetry,
}: {
  readonly data: ListAiModelCallGroupsResponse | undefined
  readonly filters: CallFilters
  readonly loading: boolean
  readonly error: boolean
  readonly offset: number
  readonly filterControl: ReactNode
  readonly onPrevious: () => void
  readonly onNext: () => void
  readonly onRetry: () => void
}) {
  const messages = useAiUsageMessages().calls
  const locale = useLocale()
  const groups = data?.items ?? []
  return (
    <div id="ai-model-calls" className="scroll-mt-4">
      <PageSection title={messages.title} description={messages.description} action={filterControl}>
        <Panel
          footer={
            <div className="flex items-center justify-between gap-3">
              <span className="tabular-nums">
                {data?.total
                  ? messages.executions(
                      (offset + 1).toLocaleString(locale),
                      Math.min(offset + groups.length, data.total).toLocaleString(locale),
                      data.total.toLocaleString(locale)
                    )
                  : messages.noExecutions}
              </span>
              <span className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-my-1"
                  disabled={loading || offset === 0}
                  onClick={onPrevious}
                >
                  {messages.previous}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-my-1"
                  disabled={loading || !data?.hasMore}
                  onClick={onNext}
                >
                  {messages.next}
                </Button>
              </span>
            </div>
          }
        >
          <div
            className={cn(
              grid,
              "hidden h-9 px-4 text-xs font-medium text-muted-foreground md:grid [&>*:nth-child(n+3)]:text-right"
            )}
          >
            <span>{messages.execution}</span>
            <span>{messages.columns.model}</span>
            <span>{messages.columns.calls}</span>
            <span>{messages.columns.usage}</span>
            <span>{messages.columns.cost}</span>
            <span className="text-left!">{messages.columns.valuation}</span>
          </div>
          {loading ? (
            <Notice>{messages.loading}</Notice>
          ) : error ? (
            <Notice onRetry={onRetry}>{messages.failed}</Notice>
          ) : groups.length === 0 ? (
            <Notice>{messages.empty}</Notice>
          ) : (
            groups.map((group) => (
              <GroupRow key={group.executionId} group={group} filters={filters} />
            ))
          )}
        </Panel>
      </PageSection>
    </div>
  )
}

function groupLabel(group: Group, messages: AiUsageMessages["calls"]): string {
  if (group.label) return group.label
  const source = group.attribution
  if (source?.kind === "agent") return messages.agent
  if (source?.kind === "workflowAgent" || source?.kind === "workflow") {
    return messages.workflow(source.workflowId)
  }
  if (source?.kind === "action") return messages.action(source.actionId)
  if (source?.kind === "request") return messages.request(source.requestId)
  return messages.execution
}

// An agent conversation links only for someone who may read it; the server says who.
function groupHref(group: Group): string | undefined {
  const source = group.attribution
  if (source?.kind === "agent") {
    return group.canOpenThread ? `/agents/${encodeURIComponent(source.threadId)}` : undefined
  }
  if (source?.kind === "workflowAgent" || source?.kind === "workflow") {
    return workflowRunHref(source.workflowRunId)
  }
  if (source?.kind === "action") return actionRunHref(source.actionRunId)
  return undefined
}

function GroupRow({ group, filters }: { readonly group: Group; readonly filters: CallFilters }) {
  const messages = useAiUsageMessages().calls
  const format = useCallFormat()
  const [open, setOpen] = useState(false)
  const children = group.executions.filter(
    (execution) => execution.executionId !== group.executionId
  )
  const direct = group.executions.find((execution) => execution.executionId === group.executionId)
  const models = [
    ...new Map(
      group.executions.flatMap((execution) =>
        execution.models.map((model) => [`${model.providerId}/${model.modelId}`, model] as const)
      )
    ).values(),
  ]
  const label = groupLabel(group, messages)
  const href = groupHref(group)
  const kind = group.attribution?.kind
  const Icon =
    kind === "agent"
      ? Bot
      : kind === "action"
        ? Zap
        : kind === "workflow" || kind === "workflowAgent"
          ? Workflow
          : Layers

  return (
    <div className={cn(open && "bg-muted/25")}>
      <div className={cn(grid, "px-4 py-2.5")}>
        <div className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
              <Icon className="size-4 text-muted-foreground" aria-hidden />
            </span>
            <span className="min-w-0">
              <span title={label} className="block truncate text-sm font-medium">
                {label}
              </span>
              <span className="block text-xs text-muted-foreground">
                {format.time(group.firstCallAt)}
                {children.length > 0 ? ` · ${messages.subAgents(children.length)}` : ""}
              </span>
            </span>
          </button>
          {href ? (
            <Link
              to={href}
              aria-label={messages.open(label)}
              title={messages.open(label)}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
        <Summary summary={group} models={models} />
      </div>
      {open ? (
        children.length === 0 ? (
          <Calls executionId={group.executionId} filters={filters} />
        ) : (
          <>
            {direct ? (
              <ExecutionRow execution={direct} label={messages.direct} filters={filters} />
            ) : (
              <Notice indent>{messages.noDirect}</Notice>
            )}
            {children.map((execution, index) => (
              <ExecutionRow
                key={execution.executionId}
                execution={execution}
                label={execution.label ?? messages.subAgent(index + 1)}
                filters={filters}
                child
              />
            ))}
          </>
        )
      ) : null}
    </div>
  )
}

function ExecutionRow({
  execution,
  label,
  filters,
  child = false,
}: {
  readonly execution: Execution
  readonly label: string
  readonly filters: CallFilters
  readonly child?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className={cn(grid, "py-2 pr-4 pl-10")}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          {child ? (
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
          <span title={execution.executionId} className="truncate text-xs font-medium">
            {label}
          </span>
        </button>
        <Summary summary={execution} models={execution.models} />
      </div>
      {open ? <Calls executionId={execution.executionId} filters={filters} nested /> : null}
    </>
  )
}

function Calls({
  executionId,
  filters,
  nested = false,
}: {
  readonly executionId: string
  readonly filters: CallFilters
  readonly nested?: boolean
}) {
  const messages = useAiUsageMessages().calls
  const locale = useLocale()
  const [offset, setOffset] = useState(0)
  const query = useQuery({
    ...listAiModelCallsOptions({
      query: { ...filters, executionId, limit: String(callsPageSize), offset: String(offset) },
    }),
    retry: false,
  })
  if (query.isPending) return <Notice indent>{messages.loadingCalls}</Notice>
  if (query.isError || !query.data) {
    return (
      <Notice indent onRetry={() => void query.refetch()}>
        {messages.callsFailed}
      </Notice>
    )
  }
  if (query.data.items.length === 0) return <Notice indent>{messages.empty}</Notice>
  const { items, total, hasMore } = query.data
  return (
    <>
      {items.map((call) => (
        <ModelCallRow key={call.usage.id} call={call} nested={nested} />
      ))}
      {total > callsPageSize ? (
        <div className="flex items-center justify-between gap-3 py-1.5 pr-4 pl-14 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {messages.callRange(
              (offset + 1).toLocaleString(locale),
              (offset + items.length).toLocaleString(locale),
              total.toLocaleString(locale)
            )}
          </span>
          <span className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - callsPageSize))}
            >
              {messages.previousCalls}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!hasMore}
              onClick={() => setOffset(offset + callsPageSize)}
            >
              {messages.nextCalls}
            </Button>
          </span>
        </div>
      ) : null}
    </>
  )
}

/** One model call: when, which model, what it used and cost, and where its cost came from. */
export function ModelCallRow({
  call,
  nested = false,
}: {
  readonly call: ModelCall
  readonly nested?: boolean
}) {
  const messages = useAiUsageMessages().calls
  const format = useCallFormat()
  const { audioDurationMs, totalTokens } = call.usage.usage
  return (
    <div className={cn(grid, "py-1.5 pr-4 text-xs", nested ? "pl-20" : "pl-14")}>
      <span
        className="text-muted-foreground"
        title={`${call.usage.callId} · ${call.usage.attempt}`}
      >
        {format.time(call.usage.occurredAt, true)}
      </span>
      <span className="hidden min-w-0 md:block">
        <ModelName
          models={[{ providerId: call.usage.providerId, modelId: call.usage.requestedModelId }]}
        />
        {call.usage.modelKind === "transcription" ? (
          <span className="block text-muted-foreground">{messages.transcription}</span>
        ) : null}
        {call.usage.requestedReasoning === undefined ? null : (
          <span className="block text-muted-foreground">
            {typeof call.usage.requestedReasoning === "string"
              ? messages.reasoning(call.usage.requestedReasoning)
              : messages.reasoningBudget(format.number(call.usage.requestedReasoning.budgetTokens))}
          </span>
        )}
      </span>
      <span className="hidden text-right font-mono text-muted-foreground md:block">1</span>
      <span className="hidden text-right font-mono tabular-nums md:block">
        {audioDurationMs !== undefined ? (
          <span className="block">{messages.audio(format.number(audioDurationMs / 1000, 3))}</span>
        ) : null}
        {totalTokens !== undefined ? (
          <span className="block">{messages.tokens(format.number(totalTokens))}</span>
        ) : null}
        {audioDurationMs === undefined && totalTokens === undefined ? "—" : null}
      </span>
      <span className="text-right font-mono whitespace-nowrap tabular-nums">
        {call.cost && call.cost.status !== "unpriceable" ? format.money(call.cost.money) : "—"}
      </span>
      <span className="hidden md:block">
        <Valuation call={call} />
      </span>
    </div>
  )
}

function Summary({
  summary,
  models,
}: {
  readonly summary: Group | Execution
  readonly models: Execution["models"]
}) {
  const messages = useAiUsageMessages().calls
  const format = useCallFormat()
  const withoutCost = summary.costs.unvaluedCallCount + summary.costs.unpriceableCallCount
  return (
    <>
      <span className="hidden min-w-0 md:block">
        <ModelName models={models} />
      </span>
      <span className="hidden text-right font-mono text-xs tabular-nums md:block">
        {format.number(summary.modelCallCount)}
      </span>
      <span className="hidden text-right font-mono text-xs tabular-nums md:block">
        {summary.totalTokens === undefined
          ? "—"
          : messages.tokens(format.number(summary.totalTokens))}
      </span>
      <span className="text-right font-mono text-xs whitespace-nowrap tabular-nums">
        {summary.costs.amounts.length
          ? summary.costs.amounts.map((money) => (
              <span key={money.currency} className="block">
                {format.money(money)}
              </span>
            ))
          : "—"}
      </span>
      <span className="hidden text-xs text-muted-foreground md:block">
        {withoutCost > 0 ? (
          <span className="text-amber-700 dark:text-amber-300">
            {messages.withoutCost(format.number(withoutCost))}
          </span>
        ) : (
          messages.costAvailable
        )}
      </span>
    </>
  )
}

function ModelName({ models }: { readonly models: Execution["models"] }) {
  const messages = useAiUsageMessages().calls
  const model = models[0]
  if (models.length !== 1 || !model) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={models.map((entry) => `${entry.providerId} · ${entry.modelId}`).join("\n")}
      >
        {messages.models(models.length)}
      </span>
    )
  }
  return (
    <span className="block min-w-0 text-xs">
      <span className="block truncate font-medium" title={model.modelId}>
        {model.modelId}
      </span>
      <span className="block text-muted-foreground">{model.providerId}</span>
    </span>
  )
}

function Valuation({ call }: { readonly call: ModelCall }) {
  const messages = useAiUsageMessages().calls
  const cost = call.cost
  const { label, tone }: { label: string; tone: Tone } =
    cost?.status === "rated"
      ? cost.source === "provider"
        ? { label: messages.provider, tone: "ok" }
        : {
            label: cost.source === "estimate" ? messages.estimate : messages.unclassified,
            tone: "info",
          }
      : call.valuationStatus === "unpriceable"
        ? { label: messages.unpriceable, tone: "warn" }
        : { label: messages.unvalued, tone: "warn" }
  return <Pill tone={tone}>{label}</Pill>
}

function Notice({
  children,
  indent = false,
  onRetry,
}: {
  readonly children: ReactNode
  readonly indent?: boolean
  /** Offered when what failed can be read again. */
  readonly onRetry?: () => void
}) {
  const messages = useAiUsageMessages()
  return (
    <p
      className={cn(
        "flex items-center justify-center gap-3 py-6 text-[0.8125rem] text-muted-foreground",
        indent && "justify-start py-3 pl-14 text-xs"
      )}
    >
      {children}
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {messages.retry}
        </Button>
      ) : null}
    </p>
  )
}

function useCallFormat() {
  const locale = useLocale()
  return {
    time: (value: string, seconds = false) =>
      new Date(value).toLocaleString(locale, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
      }),
    number: (value: number, digits = 0) =>
      value.toLocaleString(locale, { maximumFractionDigits: digits }),
    money: (money: { readonly currency: string; readonly amountNanos: string }) =>
      formatMoney(money, locale),
  }
}
