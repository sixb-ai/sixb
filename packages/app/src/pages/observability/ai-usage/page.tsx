import { isSixbApiError } from "@sixb/client"
import {
  getAiAccountingOverviewOptions,
  getAiLimitStatusQueryKey,
  listAiModelCallGroupsOptions,
} from "@sixb/client/hooks"
import {
  Button,
  MiniSparkline,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChartNoAxesCombined, Loader2, RefreshCw, TriangleAlert } from "lucide-react"
import { lazy, type ReactNode, Suspense, useMemo, useState } from "react"
import { SectionPage } from "../../section-page"
import { PageSection, Panel, PanelEmpty, PanelSkeleton, useLoadFailure } from "../../section-ui"
import { type CallFilters, callsPageSize, ModelCalls } from "./calls"
import {
  amountFor,
  bucketFor,
  currenciesOf,
  formatChartMoney,
  formatCompact,
  formatMoney,
  formatPercent,
  nanosToNumber,
  type Overview,
  periodTokens,
  type RangePreset,
  rangePresets,
  reportingCoverage,
  type UsageField,
  usageShare,
} from "./format"
import { AiLimits, limitStatusQuery } from "./limits"
import { useAiUsageMessages } from "./messages"

const TimeSeries = lazy(() => import("./charts"))

type Valuation = "rated" | "unpriceable" | "unvalued"
const valuations: readonly Valuation[] = ["rated", "unpriceable", "unvalued"]

/**
 * Observability › AI usage: this month's limits, then what models were called in a range — cost,
 * tokens and how complete the accounting is — and every call behind it.
 */
export function ObservabilityAiUsagePage() {
  const messages = useAiUsageMessages()
  const locale = useLocale()
  const queryClient = useQueryClient()
  const [preset, setPreset] = useState<RangePreset>("7d")
  // The range ends when it was chosen; Refresh moves it to now.
  const [end, setEnd] = useState(() => new Date())
  const [providerId, setProviderId] = useState<string>()
  const [modelId, setModelId] = useState<string>()
  const [chosenCurrency, setCurrency] = useState<string>()
  const [valuation, setValuation] = useState<Valuation>()
  const [offset, setOffset] = useState(0)

  const range = useMemo(() => {
    const span = rangePresets.find((entry) => entry.id === preset)?.ms ?? rangePresets[1].ms
    return { from: new Date(end.getTime() - span).toISOString(), to: end.toISOString() }
  }, [preset, end])
  const bucket = bucketFor(range)
  // The unfiltered overview also lists every provider and model, so the filters can offer them.
  const allQuery = useQuery({
    ...getAiAccountingOverviewOptions({ query: { ...range, bucket } }),
    retry: false,
  })
  const filtered = providerId !== undefined || modelId !== undefined
  const filteredQuery = useQuery({
    ...getAiAccountingOverviewOptions({ query: { ...range, bucket, providerId, modelId } }),
    enabled: filtered,
    retry: false,
  })
  const overview = filtered ? filteredQuery.data : allQuery.data
  const callFilters: CallFilters = { ...range, providerId, modelId, valuationStatus: valuation }
  const callsQuery = useQuery({
    ...listAiModelCallGroupsOptions({
      query: { ...callFilters, limit: String(callsPageSize), offset: String(offset) },
    }),
    retry: false,
  })
  const currencies = useMemo(() => currenciesOf(overview), [overview])
  const currency =
    chosenCurrency && currencies.includes(chosenCurrency)
      ? chosenCurrency
      : currencies.includes("USD")
        ? "USD"
        : currencies[0]

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getAiLimitStatusQueryKey(limitStatusQuery) })
    setEnd(new Date())
  }
  const changeFilter = (apply: () => void) => {
    apply()
    setOffset(0)
  }
  const loading = allQuery.isPending || (filtered && filteredQuery.isPending)
  const error = allQuery.error ?? filteredQuery.error
  const failure = useLoadFailure(error, { denied: messages.denied, fallback: messages.unavailable })

  return (
    <SectionPage
      section="observability"
      page="ai-usage"
      width="wide"
      title={messages.title}
      description={messages.description}
      actions={
        <>
          <div className="inline-flex rounded-lg bg-muted/70 p-0.5 ring-1 ring-border/70">
            {rangePresets.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={preset === entry.id}
                onClick={() => {
                  setPreset(entry.id)
                  setEnd(new Date())
                  setOffset(0)
                }}
                className={cn(
                  "h-7 rounded-md px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground",
                  preset === entry.id && "bg-background text-foreground ring-1 ring-border"
                )}
              >
                {messages.ranges[entry.id]}
              </button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={refresh}
            aria-label={messages.refresh}
          >
            <RefreshCw />
          </Button>
        </>
      }
    >
      <AiLimits />

      <PageSection
        title={messages.usageTitle}
        description={messages.usageDescription}
        action={
          <div className="flex flex-wrap justify-end gap-2">
            <FilterSelect
              name={messages.providerFilter}
              all={messages.allProviders}
              value={providerId}
              options={[...new Set((allQuery.data?.models ?? []).map((model) => model.providerId))]}
              onChange={(value) =>
                changeFilter(() => {
                  setProviderId(value)
                  const keepsModel = allQuery.data?.models.some(
                    (model) => model.modelId === modelId && (!value || model.providerId === value)
                  )
                  if (!keepsModel) setModelId(undefined)
                })
              }
            />
            <FilterSelect
              name={messages.modelFilter}
              all={messages.allModels}
              value={modelId}
              options={(allQuery.data?.models ?? [])
                .filter((model) => !providerId || model.providerId === providerId)
                .map((model) => model.modelId)}
              onChange={(value) => changeFilter(() => setModelId(value))}
            />
            {currencies.length > 1 ? (
              <FilterSelect
                name={messages.currency}
                all={messages.currency}
                value={currency}
                options={currencies}
                required
                onChange={setCurrency}
              />
            ) : null}
          </div>
        }
      >
        {loading ? (
          <Panel>
            <PanelSkeleton rows={4} />
          </Panel>
        ) : error || !overview ? (
          <Panel>
            <PanelEmpty
              tone="error"
              icon={TriangleAlert}
              title={failure.title}
              description={failure.description}
              action={
                <Button type="button" variant="outline" size="sm" onClick={refresh}>
                  {messages.retry}
                </Button>
              }
            />
          </Panel>
        ) : overview.totals.modelCallCount === 0 ? (
          <Panel>
            <PanelEmpty
              icon={ChartNoAxesCombined}
              title={messages.emptyTitle}
              description={messages.empty}
            />
          </Panel>
        ) : (
          <Usage
            overview={overview}
            currency={currency}
            locale={locale}
            onReview={(status) => {
              changeFilter(() => setValuation(status))
              document.getElementById("ai-model-calls")?.scrollIntoView({ behavior: "smooth" })
            }}
          />
        )}
      </PageSection>

      {/* Someone who may manage limits but not see usage gets the limits alone. */}
      {isSixbApiError(error) && error.status === 403 ? null : (
        <ModelCalls
          key={JSON.stringify({ ...callFilters, offset })}
          data={callsQuery.data}
          filters={callFilters}
          loading={callsQuery.isPending}
          error={callsQuery.isError}
          onRetry={() => void callsQuery.refetch()}
          offset={offset}
          onPrevious={() => setOffset((value) => Math.max(0, value - callsPageSize))}
          onNext={() => setOffset((value) => value + callsPageSize)}
          filterControl={
            <FilterSelect
              name={messages.calls.valuationFilter}
              all={messages.calls.allValuations}
              value={valuation}
              options={valuations}
              label={(value) => messages.calls.valuations[value]}
              onChange={(value) => changeFilter(() => setValuation(value))}
            />
          }
        />
      )}
    </SectionPage>
  )
}

function Usage({
  overview,
  currency,
  locale,
  onReview,
}: {
  readonly overview: Overview
  readonly currency: string | undefined
  readonly locale: string
  readonly onReview: (status: "unpriceable" | "unvalued") => void
}) {
  const messages = useAiUsageMessages()
  const totals = overview.totals
  const count = (value: number) => value.toLocaleString(locale)
  const reporting = useReporting()
  const rated = totals.costs.ratedCallCount
  const coverage = totals.modelCallCount === 0 ? 0 : (rated / totals.modelCallCount) * 100
  const money = (value: number) => formatChartMoney(value, currency, locale)
  const selected = amountFor(totals.costs.amounts, currency)
  const costSeries = overview.series.map((period) => {
    const amount = amountFor(period.costs.amounts, currency)
    // An empty period cost nothing; a period whose calls have no cost is unknown.
    return {
      at: period.start,
      cost: amount
        ? nanosToNumber(amount.amountNanos)
        : period.modelCallCount === 0
          ? 0
          : undefined,
    }
  })
  const tokenSeries = overview.series.map((period) => ({
    at: period.start,
    input: periodTokens(period, "inputTokens"),
    output: periodTokens(period, "outputTokens"),
  }))
  const xLabel = (value: string) => {
    const date = new Date(value)
    return overview.bucket === "hour"
      ? date.toLocaleTimeString(locale, { hour: "numeric" })
      : date.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" })
  }
  const ranked = <T,>(
    entries: readonly T[],
    amounts: (entry: T) => readonly { currency: string; amountNanos: string }[],
    key: (entry: T) => string,
    label: (entry: T) => string
  ) =>
    entries
      .flatMap((entry) => {
        const amount = amountFor(amounts(entry), currency)
        return amount
          ? [{ key: key(entry), label: label(entry), value: nanosToNumber(amount.amountNanos) }]
          : []
      })
      .sort((left, right) => right.value - left.value)
      .slice(0, 8)
  const byModel = ranked(
    overview.models,
    (model) => model.costs.amounts,
    (model) => `${model.providerId}/${model.modelId}`,
    (model) => model.modelId
  )
  const byAgent = ranked(
    overview.agents,
    (agent) => agent.costs.amounts,
    (agent) => (agent.kind === "agent" ? "agent" : `${agent.workflowId}/${agent.agentStepId}`),
    (agent) =>
      agent.kind === "agent" ? messages.charts.agent : `${agent.workflowId} · ${agent.agentStepId}`
  )
  const byWorkflow = ranked(
    overview.workflows,
    (workflow) => workflow.costs.amounts,
    (workflow) => workflow.workflowId,
    (workflow) => workflow.workflowId
  )
  const withoutCost = totals.costs.unpriceableCallCount + totals.costs.unvaluedCallCount
  const reviewStatus = totals.costs.unpriceableCallCount > 0 ? "unpriceable" : "unvalued"
  const reviewCount =
    reviewStatus === "unpriceable"
      ? totals.costs.unpriceableCallCount
      : totals.costs.unvaluedCallCount
  const audio = totals.usage.audioDurationMs

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "grid gap-3 sm:grid-cols-2",
          audio === undefined ? "xl:grid-cols-4" : "xl:grid-cols-5"
        )}
      >
        <Metric
          label={messages.metrics.cost}
          value={
            selected ? formatChartMoney(nanosToNumber(selected.amountNanos), currency, locale) : "—"
          }
          exact={selected ? formatMoney(selected, locale) : undefined}
          detail={currency ? messages.metrics.costIn(currency) : messages.metrics.noCost}
          spark={
            costSeries.every((point) => point.cost !== undefined)
              ? costSeries.map((point) => ({ timestamp: point.at, value: point.cost ?? 0 }))
              : undefined
          }
        />
        <Metric
          label={messages.metrics.tokens}
          value={formatCompact(totals.usage.totalTokens, locale)}
          detail={reporting(totals)}
          spark={
            overview.series.every((period) => periodTokens(period, "totalTokens") !== undefined)
              ? overview.series.map((period) => ({
                  timestamp: period.start,
                  value: periodTokens(period, "totalTokens") ?? 0,
                }))
              : undefined
          }
        />
        <Metric
          label={messages.metrics.calls}
          value={count(totals.modelCallCount)}
          detail={messages.metrics.callsDetail(
            overview.models.length,
            new Set(overview.models.map((model) => model.providerId)).size
          )}
        />
        <Metric
          label={messages.metrics.coverage}
          value={formatPercent(coverage, locale)}
          detail={messages.metrics.coverageDetail(count(rated), count(totals.modelCallCount))}
        />
        {audio === undefined ? null : (
          <Metric
            label={messages.metrics.audio}
            value={messages.metrics.seconds(
              (audio / 1000).toLocaleString(locale, { maximumFractionDigits: 3 })
            )}
            detail={messages.metrics.audioDetail(
              totals.usageCoverage.fieldCallCounts.audioDurationMs,
              count(totals.usageCoverage.fieldCallCounts.audioDurationMs)
            )}
          />
        )}
      </div>

      {totals.usage.reportingStatus !== "complete" || coverage < 100 ? (
        <div className="flex flex-col gap-3 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[0.8125rem] sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="font-medium">{messages.partialTitle}</p>
              <p className="mt-0.5 text-muted-foreground">
                {[
                  totals.usage.reportingStatus !== "complete"
                    ? messages.partialTokens(reporting(totals))
                    : null,
                  coverage < 100 ? messages.partialCost(withoutCost, count(withoutCost)) : null,
                ]
                  .filter(Boolean)
                  .join(". ")}
                .
              </p>
            </div>
          </div>
          {reviewCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onReview(reviewStatus)}
            >
              {messages.review(reviewCount)}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Cards in a row share its height, so a short one leaves no gap below it. */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title={messages.charts.costOverTime}
          description={
            currency ? messages.charts.costOverTimeIn(currency) : messages.charts.noCostRange
          }
        >
          <Chart
            data={selected ? costSeries : []}
            xKey="at"
            yAxisWidth={68}
            showLegend={false}
            series={[{ key: "cost", label: messages.charts.cost, color: "var(--chart-1)" }]}
            xFormatter={xLabel}
            valueFormatter={money}
            emptyLabel={messages.charts.noCost}
            ariaLabel={messages.charts.costOverTime}
          />
        </Card>
        <Card
          title={messages.charts.costByModel}
          description={messages.charts.costByModelDescription}
        >
          <Breakdown data={byModel} format={money} empty={messages.charts.noCost} />
        </Card>
        <Card
          className="xl:col-span-2"
          title={messages.charts.tokens}
          description={messages.charts.tokensDescription(reporting(totals))}
        >
          <Chart
            data={tokenSeries}
            xKey="at"
            series={[
              {
                key: "input",
                label: messages.charts.input,
                color: "var(--chart-1)",
                stackId: "tokens",
              },
              {
                key: "output",
                label: messages.charts.output,
                color: "var(--chart-3)",
                stackId: "tokens",
              },
            ]}
            xFormatter={xLabel}
            valueFormatter={(value) => formatCompact(value, locale)}
            tooltipLabel={(value) => {
              const period = overview.series.find((entry) => entry.start === value)
              return (
                <span className="block max-w-56 whitespace-normal">
                  {xLabel(value)}
                  {period ? <span className="mt-1 block">{reporting(period)}</span> : null}
                </span>
              )
            }}
            emptyLabel={messages.charts.noTokens}
            ariaLabel={messages.charts.tokens}
          />
        </Card>
        <Insights overview={overview} coverage={coverage} locale={locale} />
      </div>

      {byAgent.length > 1 || byWorkflow.length > 1 ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {byAgent.length > 1 ? (
            <Card title={messages.charts.costByAgent} description={messages.charts.highest}>
              <Breakdown data={byAgent} format={money} empty={messages.charts.noCost} />
            </Card>
          ) : null}
          {byWorkflow.length > 1 ? (
            <Card title={messages.charts.costByWorkflow} description={messages.charts.highest}>
              <Breakdown data={byWorkflow} format={money} empty={messages.charts.noCost} />
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** "Partial — complete usage reported for 84 of 87 calls", for a whole range or one meter. */
function useReporting() {
  const messages = useAiUsageMessages().reporting
  const locale = useLocale()
  return (aggregate: Overview["totals"], field?: UsageField): string => {
    if (aggregate.modelCallCount === 0) return messages.none
    const { status, count } = reportingCoverage(aggregate, field)
    const counts = [
      count.toLocaleString(locale),
      aggregate.modelCallCount.toLocaleString(locale),
    ] as const
    return field ? messages.field(...counts) : messages[status](...counts)
  }
}

function Insights({
  overview,
  coverage,
  locale,
}: {
  readonly overview: Overview
  readonly coverage: number
  readonly locale: string
}) {
  const messages = useAiUsageMessages().insights
  const reporting = useReporting()
  const totals = overview.totals
  const breakdown = (
    [
      {
        key: "rated",
        label: messages.rated,
        value: totals.costs.ratedCallCount,
        dot: "bg-foreground",
      },
      {
        key: "unpriceable",
        label: messages.unpriceable,
        value: totals.costs.unpriceableCallCount,
        dot: "bg-amber-500",
      },
      {
        key: "unvalued",
        label: messages.unvalued,
        value: totals.costs.unvaluedCallCount,
        dot: "bg-muted-foreground/40",
      },
    ] as const
  ).filter((entry) => entry.value > 0)
  return (
    <Card className="h-full" title={messages.title} description={messages.description}>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <Insight
            label={messages.cacheHitRate}
            value={formatPercent(usageShare(totals, "cacheReadInputTokens", "inputTokens"), locale)}
          />
          <Insight
            label={messages.cachedInput}
            value={formatCompact(totals.usage.cacheReadInputTokens, locale)}
            detail={reporting(totals, "cacheReadInputTokens")}
          />
          <Insight
            label={messages.reasoningShare}
            value={formatPercent(
              usageShare(totals, "reasoningOutputTokens", "outputTokens"),
              locale
            )}
          />
          <Insight
            label={messages.reasoningTokens}
            value={formatCompact(totals.usage.reasoningOutputTokens, locale)}
            detail={reporting(totals, "reasoningOutputTokens")}
          />
        </div>
        <div className="border-t border-border pt-4">
          <div className="mb-2 flex items-baseline justify-between gap-4">
            <p className="text-[0.8125rem] font-medium">{messages.valuation}</p>
            <p className="font-mono text-[0.8125rem] font-medium tabular-nums">
              {formatPercent(coverage, locale)}
            </p>
          </div>
          <div className="flex h-2 overflow-hidden rounded-full bg-muted">
            {breakdown.map((entry) => (
              <div
                key={entry.key}
                className={entry.dot}
                style={{
                  width: `${totals.modelCallCount === 0 ? 0 : (entry.value / totals.modelCallCount) * 100}%`,
                }}
              />
            ))}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {breakdown.map((entry) => (
              <div key={entry.key} className="flex items-center justify-between gap-3 text-xs">
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <span className={cn("size-2 shrink-0 rounded-full", entry.dot)} />
                  <span className="truncate">{entry.label}</span>
                </span>
                <span className="font-mono tabular-nums">{entry.value.toLocaleString(locale)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  )
}

function Insight({
  label,
  value,
  detail,
}: {
  readonly label: string
  readonly value: string
  readonly detail?: string
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{value}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

function Metric({
  label,
  value,
  exact,
  detail,
  spark,
}: {
  readonly label: string
  readonly value: string
  /** The value in full, on hover, when `value` is rounded. */
  readonly exact?: string
  readonly detail: string
  readonly spark?: readonly { readonly timestamp: string; readonly value: number }[]
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card px-4 py-3.5 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-3">
        <div className="truncate text-2xl font-semibold tracking-tight tabular-nums" title={exact}>
          {value}
        </div>
        {spark && spark.length > 1 ? (
          <MiniSparkline data={[...spark]} width={72} height={28} className="shrink-0" />
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function Card({
  title,
  description,
  className,
  children,
}: {
  readonly title: string
  readonly description: string
  readonly className?: string
  readonly children: ReactNode
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-border bg-card px-5 py-4 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]",
        className
      )}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-0.5 mb-4 text-xs text-muted-foreground">{description}</p>
      {/* A chart grows into the height its row gives the card. */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

function Chart(props: Parameters<typeof TimeSeries>[0]) {
  const messages = useAiUsageMessages().charts
  return (
    <Suspense
      fallback={
        <div
          className="flex flex-1 items-center justify-center text-[0.8125rem] text-muted-foreground"
          style={{ minHeight: props.height ?? 260 }}
        >
          <Loader2 className="mr-2 size-4 animate-spin" />
          {messages.loading}
        </div>
      }
    >
      <TimeSeries {...props} />
    </Suspense>
  )
}

function Breakdown({
  data,
  format,
  empty,
}: {
  readonly data: readonly { readonly key: string; readonly label: string; readonly value: number }[]
  readonly format: (value: number) => string
  readonly empty: string
}) {
  if (data.length === 0) {
    return (
      <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border text-[0.8125rem] text-muted-foreground">
        {empty}
      </div>
    )
  }
  const maximum = Math.max(...data.map((entry) => entry.value), 0)
  return (
    <div className="flex flex-col gap-3.5">
      {data.map((entry) => (
        <div key={entry.key}>
          <div className="mb-1.5 flex items-start justify-between gap-4 text-[0.8125rem]">
            <span className="min-w-0 break-words text-muted-foreground">{entry.label}</span>
            <span className="shrink-0 font-mono font-medium tabular-nums">
              {format(entry.value)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-[var(--chart-2)]"
              style={{
                width:
                  entry.value > 0
                    ? `${Math.max(maximum === 0 ? 0 : (entry.value / maximum) * 100, 0.75)}%`
                    : 0,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function FilterSelect<T extends string>({
  name,
  all,
  value,
  options,
  label = (option) => option,
  required = false,
  onChange,
}: {
  /** What the select chooses, for assistive technology. */
  readonly name: string
  /** The choice that clears the filter. */
  readonly all: string
  readonly value: T | undefined
  readonly options: readonly T[]
  readonly label?: (option: T) => string
  /** Some value is always chosen, so there is no "all". */
  readonly required?: boolean
  readonly onChange: (value: T | undefined) => void
}) {
  const allValue = "__all__"
  return (
    <Select
      value={value ?? allValue}
      onValueChange={(next) => onChange(options.find((option) => option === next))}
    >
      <SelectTrigger size="sm" className="h-8 min-w-36 text-[0.8125rem]" aria-label={name}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {required ? null : (
          <SelectItem value={allValue} className="text-[0.8125rem]">
            {all}
          </SelectItem>
        )}
        {[...new Set(options)].map((option) => (
          <SelectItem key={option} value={option} className="text-[0.8125rem]">
            {label(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
