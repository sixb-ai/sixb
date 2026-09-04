import type {
  ListAiModelCallGroupsResponse,
  ListAiModelCallsData,
  ListAiModelCallsResponse,
} from "@sixb/client"
import { listAiModelCallsOptions } from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { ArrowUpRight, Bot, ChevronRight, GitBranch, Layers } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Link } from "react-router-dom"
import { formatMoney } from "../lib/aiAccounting"

type Group = ListAiModelCallGroupsResponse["items"][number]
type Execution = Group["executions"][number]
type ModelCall = ListAiModelCallsResponse["items"][number]
type Filters = Omit<ListAiModelCallsData["query"], "executionId" | "offset" | "limit">
const PAGE_SIZE = 25

export function AiModelCallsTable({
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
  data?: ListAiModelCallGroupsResponse
  filters: Filters
  loading: boolean
  error: boolean
  offset: number
  filterControl: ReactNode
  onPrevious: () => void
  onNext: () => void
  onRetry: () => void
}) {
  const groups = data?.items ?? []
  return (
    <Card id="ai-model-calls" className="scroll-mt-4">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Model calls</CardTitle>
          <CardDescription>
            Grouped by initiating run, including sub-agents. Totals follow your filters.
          </CardDescription>
        </div>
        {filterControl}
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <div className="[&_[data-slot=table-container]]:max-h-[70vh] [&_[data-slot=table-container]]:overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead className="min-w-60 pl-6">Execution</TableHead>
                <TableHead className="min-w-40">Model</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="pr-6">Valuation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <NoticeRow>Loading model calls…</NoticeRow>
              ) : error ? (
                <NoticeRow onRetry={onRetry}>Could not load model calls.</NoticeRow>
              ) : groups.length === 0 ? (
                <NoticeRow>No model calls match these filters.</NoticeRow>
              ) : (
                groups.map((group) => (
                  <GroupRows key={group.executionId} group={group} filters={filters} />
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-6 py-3">
          <p className="text-xs text-muted-foreground">
            {data?.total
              ? `${offset + 1}–${Math.min(offset + groups.length, data.total)} of ${data.total.toLocaleString()} runs`
              : "0 runs"}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading || offset === 0}
              onClick={onPrevious}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || !data?.hasMore}
              onClick={onNext}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function GroupRows({ group, filters }: { group: Group; filters: Filters }) {
  const [open, setOpen] = useState(false)
  const children = group.executions.filter(
    (execution) => execution.executionId !== group.executionId
  )
  const direct = group.executions.find((execution) => execution.executionId === group.executionId)
  const models = [
    ...new Map(
      group.executions.flatMap((execution) =>
        execution.models.map((model) => [JSON.stringify(model), model] as const)
      )
    ).values(),
  ]
  const label =
    group.label ||
    (group.attribution?.kind === "agent"
      ? "Agent"
      : group.attribution?.kind === "workflowAgent"
        ? `Workflow · ${group.attribution.workflowId}`
        : "Execution")
  const Icon = group.attribution?.kind === "agent" ? Bot : Layers
  const href =
    group.attribution?.kind === "agent" && group.canOpenThread
      ? `/agents/${encodeURIComponent(group.attribution.threadId)}`
      : group.attribution?.kind === "workflowAgent"
        ? `/workflows/${encodeURIComponent(group.attribution.workflowId)}?run=${encodeURIComponent(group.attribution.workflowRunId)}`
        : undefined
  return (
    <>
      <TableRow className={open ? "bg-muted/35 hover:bg-muted/35" : undefined}>
        <TableCell className="pl-4">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight
                aria-hidden="true"
                className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
              />
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span title={label} className="block max-w-48 truncate font-medium">
                  {label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatTime(group.firstCallAt)}
                  {children.length > 0
                    ? ` · ${children.length} sub-agent${children.length === 1 ? "" : "s"}`
                    : ""}
                </span>
              </span>
            </button>
            {href ? (
              <Link
                to={href}
                aria-label={`Open ${label}`}
                title="Open source"
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
          </div>
        </TableCell>
        <SummaryCells summary={group} models={models} />
      </TableRow>
      {open ? (
        children.length === 0 ? (
          <ExecutionCalls executionId={group.executionId} filters={filters} />
        ) : (
          <>
            {direct ? (
              <ExecutionRows execution={direct} label="Direct calls" filters={filters} />
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="py-3 pl-14 text-xs text-muted-foreground">
                  No direct calls match these filters.
                </TableCell>
              </TableRow>
            )}
            {children.map((execution, index) => (
              <ExecutionRows
                key={execution.executionId}
                execution={execution}
                label={execution.label ?? `Sub-agent ${index + 1}`}
                filters={filters}
                child
              />
            ))}
          </>
        )
      ) : null}
    </>
  )
}

function ExecutionRows({
  execution,
  label,
  filters,
  child = false,
}: {
  execution: Execution
  label: string
  filters: Filters
  child?: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TableRow className="bg-muted/10">
        <TableCell className="pl-10">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            />
            {child ? (
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : null}
            <span title={execution.executionId} className="max-w-60 truncate text-xs font-medium">
              {label}
            </span>
          </button>
        </TableCell>
        <SummaryCells summary={execution} models={execution.models} />
      </TableRow>
      {open ? (
        <ExecutionCalls executionId={execution.executionId} filters={filters} nested />
      ) : null}
    </>
  )
}

function ExecutionCalls({
  executionId,
  filters,
  nested = false,
}: {
  executionId: string
  filters: Filters
  nested?: boolean
}) {
  const [offset, setOffset] = useState(0)
  const query = useQuery(
    listAiModelCallsOptions({
      query: { ...filters, executionId, limit: String(PAGE_SIZE), offset: String(offset) },
    })
  )
  if (query.isLoading) return <NoticeRow>Loading calls…</NoticeRow>
  if (query.isError)
    return <NoticeRow onRetry={() => void query.refetch()}>Could not load calls.</NoticeRow>
  const data = query.data
  if (!data?.items.length) return <NoticeRow>No model calls match these filters.</NoticeRow>
  return (
    <>
      {data.items.map((call) => (
        <ModelCallRow key={call.usage.id} call={call} nested={nested} />
      ))}
      {data.total > PAGE_SIZE ? (
        <TableRow>
          <TableCell colSpan={6} className="py-2 pl-14 pr-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {offset + 1}–{offset + data.items.length} of {data.total} calls
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous calls
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!data.hasMore}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next calls
                </Button>
              </div>
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  )
}

export function ModelCallRow({ call, nested = false }: { call: ModelCall; nested?: boolean }) {
  return (
    <TableRow className="text-xs">
      <TableCell className={nested ? "pl-20" : "pl-14"}>
        <span
          className="text-muted-foreground"
          title={`Call ${call.usage.callId} · attempt ${call.usage.attempt}`}
        >
          {formatTime(call.usage.occurredAt, true)}
        </span>
      </TableCell>
      <TableCell>
        <Models
          models={[{ providerId: call.usage.providerId, modelId: call.usage.requestedModelId }]}
        />
      </TableCell>
      <TableCell className="text-right font-mono text-muted-foreground">1</TableCell>
      <TableCell className="text-right font-mono tabular-nums">
        {tokens(call.usage.usage.totalTokens)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
        {call.cost && call.cost.status !== "unpriceable" ? formatMoney(call.cost.money) : "—"}
      </TableCell>
      <TableCell className="pr-6">
        <ValuationBadge call={call} />
      </TableCell>
    </TableRow>
  )
}

function SummaryCells({
  summary,
  models,
}: {
  summary: Group | Execution
  models: Execution["models"]
}) {
  const unknown = summary.costs.unvaluedCallCount + summary.costs.unpriceableCallCount
  return (
    <>
      <TableCell>
        <Models models={models} />
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {summary.modelCallCount.toLocaleString()}
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums">
        {tokens(summary.totalTokens)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
        {summary.costs.amounts.length
          ? summary.costs.amounts.map((money) => (
              <div key={money.currency}>{formatMoney(money)}</div>
            ))
          : "—"}
      </TableCell>
      <TableCell className="pr-6 text-xs text-muted-foreground">
        <span
          title={`${summary.costs.reportedCallCount} provider-reported · ${summary.costs.ratedCallCount} estimated · ${unknown} without cost`}
        >
          {unknown > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">{unknown} without cost</span>
          ) : summary.costs.reportedCallCount === summary.modelCallCount ? (
            "Provider-reported"
          ) : summary.costs.ratedCallCount === summary.modelCallCount ? (
            "Estimated"
          ) : (
            "Reported + estimated"
          )}
        </span>
      </TableCell>
    </>
  )
}

function Models({ models }: { models: Execution["models"] }) {
  if (models.length !== 1)
    return (
      <span
        className="text-xs text-muted-foreground"
        title={models.map((model) => `${model.providerId} · ${model.modelId}`).join("\n")}
      >
        {models.length} models
      </span>
    )
  const model = models[0]!
  return (
    <div className="max-w-44 text-xs">
      <p className="truncate font-medium" title={model.modelId}>
        {model.modelId}
      </p>
      <p className="text-muted-foreground">{model.providerId}</p>
    </div>
  )
}

function NoticeRow({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <TableRow>
      <TableCell colSpan={6} className="h-24 text-center text-sm text-muted-foreground">
        {children}
        {onRetry ? (
          <Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

function tokens(value: number | undefined) {
  return value === undefined ? "—" : value.toLocaleString()
}
function formatTime(value: string, seconds = false) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  })
}

function ValuationBadge({ call }: { call: ModelCall }) {
  const labels = {
    reported: "Provider-reported",
    rated: "Estimated",
    unpriceable: "Unpriceable",
    unvalued: "Unvalued",
  }
  const reasons = {
    missingBillingIdentity: "Missing billing identity",
    missingCatalogEntry: "Missing Models.dev entry",
    missingUsageMeter: "Missing usage meter",
    unsupportedPricingDimension: "Unsupported pricing",
    invalidUsageForFormula: "Invalid usage formula",
  }
  const title =
    call.cost?.status === "unpriceable" ? reasons[call.cost.reason] : labels[call.valuationStatus]
  return (
    <Badge
      variant="outline"
      title={title}
      className={
        call.valuationStatus === "reported"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : call.valuationStatus === "rated"
            ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
            : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      }
    >
      {labels[call.valuationStatus]}
    </Badge>
  )
}
