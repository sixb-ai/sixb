import type { GetAiAccountingOverviewResponse, ListAiModelCallsResponse } from "@sixb/client"
import {
  getAiAccountingOverviewOptions,
  listAiModelCallGroupsOptions,
  listAiModelCallsQueryKey,
} from "@sixb/client/hooks"
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sixb/ui/components"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bot,
  CircleDollarSign,
  Coins,
  Cpu,
  DatabaseZap,
  RefreshCw,
  TriangleAlert,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { AiModelCallsTable } from "../components/AiModelCallsTable"
import { AiUsageBreakdown, AiUsageMetricCard, AiUsageTimeSeries } from "../components/AiUsageCharts"
import { AiUsageDateRangeControl } from "../components/AiUsageDateRangeControl"
import { formatMoney } from "../lib/aiAccounting"
import { utcAccountingRangeForCalendarDays } from "../lib/aiUsageDateRange"

const PAGE_SIZE = 25
const ALL = "__all__"

type Overview = GetAiAccountingOverviewResponse
type ModelCall = ListAiModelCallsResponse["items"][number]
type RangePreset = "24h" | "7d" | "30d" | "1y"
type RangeSelection =
  | { readonly kind: "preset"; readonly preset: RangePreset; readonly end: Date }
  | { readonly kind: "custom"; readonly from: Date; readonly through: Date }
type ValuationStatus = ModelCall["valuationStatus"]

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const RANGE_OPTIONS: readonly { value: RangePreset; label: string; milliseconds: number }[] = [
  { value: "24h", label: "24h", milliseconds: DAY_MILLISECONDS },
  { value: "7d", label: "7d", milliseconds: 7 * DAY_MILLISECONDS },
  { value: "30d", label: "30d", milliseconds: 30 * DAY_MILLISECONDS },
  { value: "1y", label: "1y", milliseconds: 365 * DAY_MILLISECONDS },
]

export function AiUsagePage() {
  const queryClient = useQueryClient()
  const [rangeSelection, setRangeSelection] = useState<RangeSelection>(() => ({
    kind: "preset",
    preset: "7d",
    end: new Date(),
  }))
  const [providerId, setProviderId] = useState<string>()
  const [modelId, setModelId] = useState<string>()
  const [currency, setCurrency] = useState<string>()
  const [valuationStatus, setValuationStatus] = useState<ValuationStatus>()
  const [offset, setOffset] = useState(0)
  const range = useMemo(() => accountingRange(rangeSelection), [rangeSelection])
  const displayedRange = useMemo(() => accountingDisplayRange(rangeSelection), [rangeSelection])
  const bucket = accountingBucket(range)

  const unfilteredQuery = useQuery(getAiAccountingOverviewOptions({ query: { ...range, bucket } }))
  const hasFilters = providerId !== undefined || modelId !== undefined
  const overviewQuery = useQuery({
    ...getAiAccountingOverviewOptions({
      query: { ...range, bucket, providerId, modelId },
    }),
    enabled: hasFilters,
  })
  const overview = (hasFilters ? overviewQuery.data : unfilteredQuery.data) as Overview | undefined
  const filterSource = unfilteredQuery.data as Overview | undefined
  const callsQuery = useQuery(
    listAiModelCallGroupsOptions({
      query: {
        ...range,
        providerId,
        modelId,
        valuationStatus,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      },
    })
  )

  const currencies = useMemo(() => accountingCurrencies(overview), [overview])
  useEffect(() => {
    if (currency && currencies.includes(currency)) return
    setCurrency(currencies.includes("USD") ? "USD" : currencies[0])
  }, [currencies, currency])

  const refresh = () => {
    if (rangeSelection.kind === "preset") {
      setRangeSelection({ ...rangeSelection, end: new Date() })
      return
    }
    void unfilteredQuery.refetch()
    if (hasFilters) void overviewQuery.refetch()
    void callsQuery.refetch()
    void queryClient.invalidateQueries({ queryKey: listAiModelCallsQueryKey({ query: range }) })
  }
  const loading = unfilteredQuery.isLoading || (hasFilters && overviewQuery.isLoading)
  const error = unfilteredQuery.error ?? overviewQuery.error

  if (loading) return <AiUsageLoading />
  if (error || !overview) {
    return (
      <EmptyState
        icon={<TriangleAlert />}
        title="AI accounting is unavailable"
        description="Atlas could not load project token usage and pricing analytics. Check that AI accounting storage is configured and migrated."
        action={<Button onClick={refresh}>Retry</Button>}
      />
    )
  }

  const totals = overview.totals
  const valuedCalls = totals.costs.reportedCallCount + totals.costs.ratedCallCount
  const coverage = totals.modelCallCount === 0 ? 0 : (valuedCalls / totals.modelCallCount) * 100
  const selectedAmount = amountForCurrency(totals.costs.amounts, currency)
  const tokenSeries = overview.series.map((period) => ({
    at: period.start,
    input: bucketTokenValue(period, "inputTokens"),
    output: bucketTokenValue(period, "outputTokens"),
  }))
  const costSeries = overview.series.map((period) => {
    const amount = amountForCurrency(period.costs.amounts, currency)
    return {
      at: period.start,
      // Empty periods are zero; periods whose calls have no cost are unknown.
      cost: amount
        ? nanosToChartValue(amount.amountNanos)
        : period.modelCallCount === 0
          ? 0
          : undefined,
    }
  })
  const modelCosts = overview.models
    .flatMap((model) => {
      const amount = amountForCurrency(model.costs.amounts, currency)
      return amount
        ? [
            {
              key: `${model.providerId}/${model.modelId}`,
              label: model.modelId,
              value: nanosToChartValue(amount.amountNanos),
            },
          ]
        : []
    })
    .sort((left, right) => right.value - left.value)
    .slice(0, 8)
  const agentCosts = overview.agents
    .flatMap((agent) => {
      const amount = amountForCurrency(agent.costs.amounts, currency)
      return amount
        ? [
            {
              key: agent.agentId,
              label: agent.agentId,
              value: nanosToChartValue(amount.amountNanos),
            },
          ]
        : []
    })
    .sort((left, right) => right.value - left.value)
    .slice(0, 8)
  const workflowCosts = overview.workflows
    .flatMap((workflow) => {
      const amount = amountForCurrency(workflow.costs.amounts, currency)
      return amount
        ? [
            {
              key: workflow.workflowId,
              label: workflow.workflowId,
              value: nanosToChartValue(amount.amountNanos),
            },
          ]
        : []
    })
    .sort((left, right) => right.value - left.value)
    .slice(0, 8)
  const valuationBreakdown = [
    { key: "reported", label: "Provider-reported", value: totals.costs.reportedCallCount },
    { key: "rated", label: "Estimated", value: totals.costs.ratedCallCount },
    { key: "unpriceable", label: "Unpriceable", value: totals.costs.unpriceableCallCount },
    { key: "unvalued", label: "Unvalued", value: totals.costs.unvaluedCallCount },
  ].filter((item) => item.value > 0)

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">AI usage</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border bg-card p-0.5">
            {RANGE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={
                  rangeSelection.kind === "preset" && rangeSelection.preset === option.value
                    ? "secondary"
                    : "ghost"
                }
                size="sm"
                className="h-7 px-2.5"
                onClick={() => {
                  setRangeSelection({ kind: "preset", preset: option.value, end: new Date() })
                  setOffset(0)
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <AiUsageDateRangeControl
            from={displayedRange.from}
            through={displayedRange.through}
            label={formatDateRange(displayedRange.from, displayedRange.through)}
            active={rangeSelection.kind === "custom"}
            onApply={(from, through) => {
              setRangeSelection({ kind: "custom", from, through })
              setOffset(0)
            }}
          />
          <Button
            variant="outline"
            size="icon-sm"
            className="bg-card"
            onClick={refresh}
            aria-label="Refresh usage"
          >
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <AccountingSelect
          label="All providers"
          value={providerId}
          options={[...new Set((filterSource?.models ?? []).map((model) => model.providerId))]}
          onChange={(value) => {
            setProviderId(value)
            setOffset(0)
            if (
              modelId &&
              !filterSource?.models.some(
                (model) => model.modelId === modelId && (!value || model.providerId === value)
              )
            ) {
              setModelId(undefined)
            }
          }}
        />
        <AccountingSelect
          label="All models"
          value={modelId}
          options={(filterSource?.models ?? [])
            .filter((model) => !providerId || model.providerId === providerId)
            .map((model) => model.modelId)}
          onChange={(value) => {
            setModelId(value)
            setOffset(0)
          }}
        />
        {currencies.length > 1 ? (
          <AccountingSelect
            label="Currency"
            value={currency}
            allowAll={false}
            options={currencies}
            onChange={setCurrency}
          />
        ) : null}
      </div>

      {totals.modelCallCount === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No model calls in this range"
          description="Token and pricing charts will appear after an agent or workflow completes a model call."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AiUsageMetricCard
              label="Recorded cost"
              value={selectedAmount ? formatMoney(selectedAmount) : "—"}
              description={`${totals.costs.reportedCallCount.toLocaleString()} reported · ${totals.costs.ratedCallCount.toLocaleString()} estimated`}
              icon={<CircleDollarSign className="size-4" />}
              sparkline={
                costSeries.every((point) => point.cost !== undefined)
                  ? costSeries.map((point) => ({ timestamp: point.at, value: point.cost! }))
                  : undefined
              }
            />
            <AiUsageMetricCard
              label="Total tokens"
              value={formatOptionalTokens(totals.usage.totalTokens)}
              description={reportingDescription(totals.usage.reportingStatus)}
              icon={<DatabaseZap className="size-4" />}
              sparkline={overview.series.map((period) => ({
                timestamp: period.start,
                value: period.usage.totalTokens ?? 0,
              }))}
            />
            <AiUsageMetricCard
              label="Model calls"
              value={totals.modelCallCount.toLocaleString()}
              description={`${overview.models.length.toLocaleString()} ${overview.models.length === 1 ? "model" : "models"} · ${new Set(overview.models.map((model) => model.providerId)).size.toLocaleString()} providers`}
              icon={<Cpu className="size-4" />}
            />
            <AiUsageMetricCard
              label="Pricing coverage"
              value={`${coverage.toFixed(coverage >= 99.95 ? 0 : 1)}%`}
              description={`${valuedCalls.toLocaleString()} of ${totals.modelCallCount.toLocaleString()} calls valued`}
              icon={<Coins className="size-4" />}
            />
          </div>

          {(totals.usage.reportingStatus !== "complete" || coverage < 100) && (
            <AccountingQualityNotice
              overview={overview}
              coverage={coverage}
              onReview={(status) => {
                setValuationStatus(status)
                setOffset(0)
                document
                  .getElementById("ai-model-calls")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }}
            />
          )}

          <div className="grid items-start gap-4 xl:grid-cols-3">
            <ChartCard
              className="xl:col-span-2"
              title="Cost over time"
              description={
                currency
                  ? `Reported amounts and catalog estimates in ${currency}; not a final invoice`
                  : "No valued calls in this range"
              }
            >
              <AiUsageTimeSeries
                data={selectedAmount ? costSeries : []}
                xKey="at"
                variant="bar"
                yAxisWidth={68}
                showLegend={false}
                series={[
                  {
                    key: "cost",
                    label: currency ? `Cost (${currency})` : "Cost",
                    color: "var(--chart-1)",
                  },
                ]}
                xFormatter={(value) => formatBucketLabel(value, bucket)}
                valueFormatter={(value) => formatChartMoney(value, currency)}
                emptyLabel="No recorded cost in this range"
                ariaLabel="Recorded AI cost over time"
              />
            </ChartCard>
            <ChartCard
              className="h-full"
              title="Cost by requested model"
              description="Highest recorded cost for the selected currency"
            >
              <AiUsageBreakdown
                data={modelCosts}
                valueLabel="Cost"
                valueFormatter={(value) => formatChartMoney(value, currency)}
                emptyLabel="No recorded model cost in this range"
                ariaLabel="Recorded AI cost by requested model"
              />
            </ChartCard>
            <ChartCard
              className="xl:col-span-2"
              title="Token usage"
              description="Input and output tokens reported by providers"
            >
              <AiUsageTimeSeries
                data={tokenSeries}
                xKey="at"
                variant="bar"
                series={[
                  {
                    key: "input",
                    label: "Input",
                    stackId: "tokens",
                    color: "var(--chart-1)",
                  },
                  {
                    key: "output",
                    label: "Output",
                    stackId: "tokens",
                    color: "var(--chart-3)",
                  },
                ]}
                xFormatter={(value) => formatBucketLabel(value, bucket)}
                valueFormatter={(value) => formatCompactNumber(value)}
                ariaLabel="Input and output token usage by period"
              />
            </ChartCard>
            <AccountingInsights
              overview={overview}
              coverage={coverage}
              valuationBreakdown={valuationBreakdown}
            />
          </div>

          {agentCosts.length > 1 || workflowCosts.length > 1 ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {agentCosts.length > 1 ? (
                <ChartCard title="Cost by agent" description="Highest recorded cost in this range">
                  <AiUsageBreakdown
                    data={agentCosts}
                    valueLabel="Cost"
                    valueFormatter={(value) => formatChartMoney(value, currency)}
                    ariaLabel="Recorded AI cost by agent"
                  />
                </ChartCard>
              ) : null}
              {workflowCosts.length > 1 ? (
                <ChartCard
                  title="Cost by workflow"
                  description="Highest recorded workflow Agent node cost in this range"
                >
                  <AiUsageBreakdown
                    data={workflowCosts}
                    valueLabel="Cost"
                    valueFormatter={(value) => formatChartMoney(value, currency)}
                    ariaLabel="Recorded AI cost by workflow"
                  />
                </ChartCard>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <AiModelCallsTable
        key={JSON.stringify({ ...range, providerId, modelId, valuationStatus, offset })}
        data={callsQuery.data}
        filters={{ ...range, providerId, modelId, valuationStatus }}
        loading={callsQuery.isLoading}
        error={callsQuery.isError}
        offset={offset}
        onPrevious={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
        onNext={() => setOffset((value) => value + PAGE_SIZE)}
        onRetry={() => void callsQuery.refetch()}
        filterControl={
          <AccountingSelect
            label="All valuations"
            value={valuationStatus}
            options={["reported", "rated", "unpriceable", "unvalued"]}
            formatOption={(value) => valuationStatusLabel(value as ValuationStatus)}
            onChange={(value) => {
              setValuationStatus(value as ValuationStatus | undefined)
              setOffset(0)
            }}
          />
        }
      />
    </div>
  )
}

function AccountingQualityNotice({
  overview,
  coverage,
  onReview,
}: {
  overview: Overview
  coverage: number
  onReview: (status: Extract<ValuationStatus, "unpriceable" | "unvalued">) => void
}) {
  const messages: string[] = []
  if (overview.totals.usage.reportingStatus !== "complete") {
    messages.push("Some providers did not report a complete token partition")
  }
  if (coverage < 100) {
    messages.push(
      `${overview.totals.costs.unpriceableCallCount + overview.totals.costs.unvaluedCallCount} calls have no available cost; totals exclude them`
    )
  }
  const reviewStatus = overview.totals.costs.unpriceableCallCount > 0 ? "unpriceable" : "unvalued"
  const reviewCount =
    reviewStatus === "unpriceable"
      ? overview.totals.costs.unpriceableCallCount
      : overview.totals.costs.unvaluedCallCount
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="font-medium">Accounting coverage is partial</p>
          <p className="mt-0.5 text-muted-foreground">{messages.join(". ")}.</p>
        </div>
      </div>
      {reviewCount > 0 ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 bg-background"
          onClick={() => onReview(reviewStatus)}
        >
          Review {reviewCount.toLocaleString()} {reviewCount === 1 ? "call" : "calls"}
        </Button>
      ) : null}
    </div>
  )
}

function AccountingInsights({
  overview,
  coverage,
  valuationBreakdown,
}: {
  overview: Overview
  coverage: number
  valuationBreakdown: readonly { key: string; label: string; value: number }[]
}) {
  const usage = overview.totals.usage
  const cacheHitRate = percentageOf(usage.cacheReadInputTokens, usage.inputTokens)
  const reasoningShare = percentageOf(usage.reasoningOutputTokens, usage.outputTokens)
  const totalCalls = overview.totals.modelCallCount

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Efficiency and coverage</CardTitle>
        <CardDescription>Token composition and cost provenance</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <InsightMetric label="Cache hit rate" value={formatOptionalPercentage(cacheHitRate)} />
          <InsightMetric
            label="Cached input"
            value={formatOptionalTokens(usage.cacheReadInputTokens)}
          />
          <InsightMetric label="Reasoning share" value={formatOptionalPercentage(reasoningShare)} />
          <InsightMetric
            label="Reasoning tokens"
            value={formatOptionalTokens(usage.reasoningOutputTokens)}
          />
        </div>

        <div className="border-t pt-5">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <p className="text-sm font-medium">Valuation coverage</p>
            <p className="font-mono text-sm font-medium tabular-nums">
              {coverage.toFixed(coverage >= 99.95 ? 0 : 1)}%
            </p>
          </div>
          <div
            className="flex h-2.5 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${coverage.toFixed(1)}% of calls have a reported or estimated cost`}
          >
            {valuationBreakdown.map((item) => (
              <div
                key={item.key}
                className={valuationSegmentClass(item.key)}
                style={{ width: `${totalCalls === 0 ? 0 : (item.value / totalCalls) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {valuationBreakdown.map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <span className={`size-2 shrink-0 rounded-full ${valuationDotClass(item.key)}`} />
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="font-mono tabular-nums">{item.value.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function InsightMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{value}</p>
    </div>
  )
}

function valuationSegmentClass(key: string): string {
  if (key === "reported") return "bg-emerald-500"
  if (key === "rated") return "bg-foreground"
  if (key === "unpriceable") return "bg-amber-500"
  return "bg-muted-foreground/40"
}

function valuationDotClass(key: string): string {
  if (key === "reported") return "bg-emerald-500"
  if (key === "rated") return "bg-foreground"
  if (key === "unpriceable") return "bg-amber-500"
  return "bg-muted-foreground/40"
}

function ChartCard({
  title,
  description,
  children,
  className,
}: {
  title: string
  description: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function AccountingSelect({
  label,
  value,
  options,
  allowAll = true,
  formatOption = (option) => option,
  onChange,
}: {
  label: string
  value?: string
  options: readonly string[]
  allowAll?: boolean
  formatOption?: (option: string) => string
  onChange: (value: string | undefined) => void
}) {
  const unique = [...new Set(options)]
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next) => onChange(next === ALL ? undefined : next)}
    >
      <SelectTrigger size="sm" className="min-w-36 bg-card">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value={ALL}>{label}</SelectItem> : null}
        {unique.map((option) => (
          <SelectItem key={option} value={option}>
            {formatOption(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AiUsageLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-16 rounded-lg bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <div key={key} className="h-32 rounded-xl border bg-muted/50" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-96 rounded-xl border bg-muted/40" />
        <div className="h-96 rounded-xl border bg-muted/40" />
      </div>
    </div>
  )
}

function accountingRange(selection: RangeSelection): { from: string; to: string } {
  if (selection.kind === "custom") {
    return utcAccountingRangeForCalendarDays(selection.from, selection.through)
  }
  const option =
    RANGE_OPTIONS.find((candidate) => candidate.value === selection.preset) ?? RANGE_OPTIONS[1]!
  return {
    from: new Date(selection.end.getTime() - option.milliseconds).toISOString(),
    to: selection.end.toISOString(),
  }
}

function accountingDisplayRange(selection: RangeSelection): { from: Date; through: Date } {
  if (selection.kind === "custom") {
    return { from: selection.from, through: selection.through }
  }
  const option =
    RANGE_OPTIONS.find((candidate) => candidate.value === selection.preset) ?? RANGE_OPTIONS[1]!
  return {
    from: new Date(selection.end.getTime() - option.milliseconds),
    through: selection.end,
  }
}

function accountingBucket(range: { from: string; to: string }): Overview["bucket"] {
  const duration = new Date(range.to).getTime() - new Date(range.from).getTime()
  if (duration <= 2 * DAY_MILLISECONDS) return "hour"
  if (duration > 180 * DAY_MILLISECONDS) return "week"
  return "day"
}

function accountingCurrencies(overview: Overview | undefined): string[] {
  if (!overview) return []
  const values = new Set<string>()
  for (const aggregate of [overview.totals, ...overview.series, ...overview.models]) {
    for (const amount of aggregate.costs.amounts) values.add(amount.currency)
  }
  return [...values].sort()
}

function amountForCurrency(
  amounts: readonly { currency: string; amountNanos: string }[],
  currency: string | undefined
) {
  return currency ? amounts.find((amount) => amount.currency === currency) : undefined
}

function bucketTokenValue(
  period: Overview["series"][number],
  key:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadInputTokens"
    | "cacheWriteInputTokens"
    | "reasoningOutputTokens"
): number | undefined {
  // Empty buckets are known zeroes. Preserve undefined only when calls exist but the provider did
  // not report that meter, so the chart does not imply complete reporting.
  return period.modelCallCount === 0 ? 0 : period.usage[key]
}

function percentageOf(numerator: number | undefined, denominator: number | undefined) {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined
  return (numerator / denominator) * 100
}

function formatOptionalPercentage(value: number | undefined): string {
  return value === undefined ? "—" : `${value.toFixed(value >= 99.95 ? 0 : 1)}%`
}

function nanosToChartValue(amountNanos: string | undefined): number {
  return amountNanos === undefined ? 0 : Number(amountNanos) / 1_000_000_000
}

function formatChartMoney(value: number, currency: string | undefined): string {
  if (!currency) return value.toLocaleString(undefined, { maximumFractionDigits: 4 })
  const maximumFractionDigits = value === 0 ? 2 : value < 0.01 ? 6 : value < 1 ? 4 : 2
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits,
  }).format(value)
}

function formatOptionalTokens(value: number | undefined): string {
  return value === undefined ? "—" : formatCompactNumber(value)
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    value
  )
}

function reportingDescription(status: Overview["totals"]["usage"]["reportingStatus"]): string {
  if (status === "complete") return "Complete provider reporting"
  if (status === "partial") return "Partial provider reporting"
  return "Token counts unavailable"
}

function formatBucketLabel(value: string, bucket: Overview["bucket"]): string {
  const date = new Date(value)
  return bucket === "hour"
    ? date.toLocaleTimeString([], { hour: "numeric" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })
}

function formatDateRange(from: Date, through: Date): string {
  if (
    from.getFullYear() === through.getFullYear() &&
    from.getMonth() === through.getMonth() &&
    from.getDate() === through.getDate()
  ) {
    return from.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
  }
  if (from.getFullYear() === through.getFullYear()) {
    const start = from.toLocaleDateString([], { month: "short", day: "numeric" })
    const end = through.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    return `${start} – ${end}`
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
  }
  return `${from.toLocaleDateString([], options)} – ${through.toLocaleDateString([], options)}`
}

function valuationStatusLabel(status: ValuationStatus): string {
  switch (status) {
    case "reported":
      return "Provider-reported"
    case "rated":
      return "Estimated"
    case "unpriceable":
      return "Unpriceable"
    case "unvalued":
      return "Unvalued"
  }
}
