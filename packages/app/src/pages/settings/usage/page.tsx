import { getAiAccountingOverviewOptions, getAiLimitStatusOptions } from "@sixb/client/hooks"
import { Button } from "@sixb/ui/components"
import { useOptionalTheme } from "@sixb/ui/hooks"
import { useLocale } from "@sixb/ui/lib/i18n"
import { useQuery } from "@tanstack/react-query"
import { ChartNoAxesCombined, Download, Info, ListFilter, TriangleAlert, X } from "lucide-react"
import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { SectionPage } from "../../section-page"
import { PageTabs, Panel, PanelEmpty, PanelSkeleton, useLoadFailure } from "../../section-ui"
import { Breakdown } from "./breakdown"
import { FilterMenu, useFilterLabels } from "./filter-menu"
import type { Overview } from "./format"
import { AiLimits, limitStatusQuery } from "./limits"
import { useAiUsageMessages } from "./messages"
import { Runs, useRunsTotal } from "./runs"
import { Segmented } from "./segmented"
import { SpendChart } from "./spend-chart"
import {
  activeRange,
  apiFilters,
  bucketLabel,
  cachedShare,
  compact,
  costOf,
  downloadCsv,
  type FilterKey,
  filterKeys,
  fineMoney,
  hasFilters,
  modelPalette,
  money,
  percent,
  priorRange,
  rangeLabel,
  readFilters,
  type SpendFilters,
  type SpendRange,
  spendRange,
  spendRanges,
  splitMoney,
  unpricedCalls,
} from "./spend-model"

type UsageTab = "spend" | "limits"

/**
 * Settings › Usage: what models were called, what it cost and who asked, narrowed by the filters
 * any number on the page sets, down to how one call was priced. Limits sit on their own tab.
 */
export function SettingsUsagePage() {
  const messages = useAiUsageMessages()
  const locale = useLocale()
  const [params, setParams] = useSearchParams()
  const tab: UsageTab = params.get("tab") === "limits" ? "limits" : "spend"
  const rangeId = params.get("range")
  // The range ends with the current period; choosing a range again moves it to now.
  const range = useMemo(() => spendRange(rangeId), [rangeId])
  const filters = useMemo(() => readFilters(params), [params])

  const update = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params)
    change(next)
    setParams(next, { replace: true })
  }
  const setFilter = (key: FilterKey, value: string | undefined) =>
    update((next) => {
      if (value === undefined || next.get(key) === value) next.delete(key)
      else next.set(key, value)
      // A model belongs to its provider; the two are one filter.
      if (key === "provider" && value === undefined) next.delete("model")
    })
  const setModel = (model: { providerId: string; modelId: string } | undefined) =>
    update((next) => {
      const same =
        model && next.get("provider") === model.providerId && next.get("model") === model.modelId
      if (!model || same) {
        next.delete("provider")
        next.delete("model")
      } else {
        next.set("provider", model.providerId)
        next.set("model", model.modelId)
      }
    })

  const tabs: { id: UsageTab; label: string }[] = [
    { id: "spend", label: messages.tabs.spend },
    { id: "limits", label: messages.tabs.limits },
  ]

  return (
    <SectionPage
      section="settings"
      page="usage"
      width="wide"
      title={messages.title}
      description={messages.subtitle(rangeLabel(range, locale))}
      actions={
        <>
          <Segmented
            label={messages.range}
            value={range.id}
            options={spendRanges.map((entry) => ({
              value: entry.id,
              label: messages.ranges[entry.id],
            }))}
            onChange={(value) =>
              update((next) => {
                next.set("range", value)
                next.delete("day")
              })
            }
          />
          <ExportButton range={range} filters={filters} />
        </>
      }
    >
      <PageTabs
        tabs={tabs}
        value={tab}
        onChange={(id) =>
          update((next) => (id === "spend" ? next.delete("tab") : next.set("tab", id)))
        }
      />

      {tab === "limits" ? (
        <AiLimits />
      ) : (
        <Spend
          range={range}
          filters={filters}
          onFilter={setFilter}
          onModel={setModel}
          onClear={() =>
            update((next) => {
              for (const key of filterKeys) next.delete(key)
            })
          }
          limitsHref={`?${new URLSearchParams({ ...(rangeId ? { range: rangeId } : {}), tab: "limits" })}`}
        />
      )}
    </SectionPage>
  )
}

interface SpendProps {
  readonly range: SpendRange
  readonly filters: SpendFilters
  readonly onFilter: (key: FilterKey, value: string | undefined) => void
  readonly onModel: (model: { providerId: string; modelId: string } | undefined) => void
  readonly onClear: () => void
  readonly limitsHref: string
}

function Spend({ range, filters, onFilter, onModel, onClear, limitsHref }: SpendProps) {
  const messages = useAiUsageMessages()
  const locale = useLocale()
  const narrowed = hasFilters(filters)
  const active = activeRange(range, filters)
  const query = apiFilters(filters)
  const bucket = range.bucket

  const overview = useQuery({
    ...getAiAccountingOverviewOptions({ query: { ...active, bucket, ...query } }),
    retry: false,
  })
  const chart = useQuery({
    ...getAiAccountingOverviewOptions({
      query: { from: range.from, to: range.to, bucket, ...query },
    }),
    retry: false,
  })
  const prior = useQuery({
    ...getAiAccountingOverviewOptions({ query: { ...priorRange(active), bucket, ...query } }),
    retry: false,
  })
  // Unfiltered, for each model's color and for what share of all spend a filter keeps.
  const everything = useQuery({
    ...getAiAccountingOverviewOptions({ query: { from: range.from, to: range.to, bucket } }),
    retry: false,
  })
  const everythingActive = useQuery({
    ...getAiAccountingOverviewOptions({ query: { ...active, bucket } }),
    enabled: narrowed,
    retry: false,
  })

  const currency = useMemo(() => {
    const currencies = new Set(
      (everything.data?.totals.costs.amounts ?? []).map((amount) => amount.currency)
    )
    return currencies.has("USD") || currencies.size === 0 ? "USD" : [...currencies].sort()[0]!
  }, [everything.data])
  const theme = useOptionalTheme()?.resolvedTheme ?? "light"
  const palette = useMemo(
    () => modelPalette(everything.data?.models, currency, theme),
    [everything.data, currency, theme]
  )
  const labels = useFilterLabels(everything.data, range)
  const failure = useLoadFailure(overview.error ?? everything.error, {
    denied: messages.denied,
    fallback: messages.unavailable,
  })

  if (overview.isError || everything.isError) {
    return (
      <Panel>
        <PanelEmpty
          tone="error"
          icon={TriangleAlert}
          title={failure.title}
          description={failure.description}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void overview.refetch()}
            >
              {messages.retry}
            </Button>
          }
        />
      </Panel>
    )
  }

  const chips = filterKeys.flatMap((key) => {
    if (key === "provider") return []
    const value = filters[key]
    if (value === undefined) return []
    const name = messages.filter.names[key === "model" ? "model" : key]
    return [{ key, name, value: labels.value(key, value, filters) }]
  })
  const empty = everything.data?.totals.modelCallCount === 0

  return (
    <div className="flex flex-col gap-7">
      <div className="-mt-1.5 flex min-h-8 flex-wrap items-center gap-2">
        <FilterMenu
          overview={everything.data}
          palette={palette}
          filters={filters}
          onFilter={onFilter}
          onModel={onModel}
        >
          <button
            type="button"
            className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border border-dashed border-border bg-background px-2.5 text-[0.8125rem] text-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <ListFilter className="size-3.5" />
            {messages.filter.add}
          </button>
        </FilterMenu>
        {chips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-lg bg-muted pr-[3px] pl-2.5 text-[0.8125rem]"
          >
            <span className="text-muted-foreground">{chip.name}</span>
            <span className="font-medium">{chip.value}</span>
            <button
              type="button"
              aria-label={messages.filter.remove(chip.name.toLowerCase())}
              onClick={() =>
                chip.key === "model" ? onModel(undefined) : onFilter(chip.key, undefined)
              }
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        {narrowed ? (
          <button
            type="button"
            onClick={onClear}
            className="ml-1 text-[0.8125rem] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-4"
          >
            {messages.filter.clear}
          </button>
        ) : (
          <span className="text-[0.8125rem] text-muted-foreground/80">{messages.filter.hint}</span>
        )}
      </div>

      {empty ? (
        <Panel>
          <PanelEmpty
            icon={ChartNoAxesCombined}
            title={messages.emptyTitle}
            description={messages.empty}
          />
        </Panel>
      ) : (
        <>
          <Hero
            loading={overview.isPending}
            overview={overview.data}
            prior={prior.data}
            all={narrowed ? everythingActive.data : overview.data}
            narrowed={narrowed}
            currency={currency}
            priorLabel={
              filters.day
                ? bucketLabel(priorRange(active).from, bucket, locale)
                : rangeLabel(priorRange(active), locale)
            }
            limitsHref={limitsHref}
            runsQuery={{ ...active, ...query }}
          />

          {!narrowed && unpricedCalls(overview.data?.totals) > 0 ? (
            <div className="-mt-3.5 flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
              <Info className="size-[15px] text-muted-foreground/70" />
              <span>{messages.hero.unpriced(unpricedCalls(overview.data?.totals))}</span>
              <button
                type="button"
                className="font-medium text-foreground hover:underline hover:underline-offset-4"
                onClick={() => {
                  const costs = overview.data?.totals.costs
                  onFilter("price", costs?.unpriceableCallCount ? "unpriceable" : "unvalued")
                  document.getElementById("usage-runs")?.scrollIntoView({ behavior: "smooth" })
                }}
              >
                {messages.hero.showThem}
              </button>
            </div>
          ) : null}

          <SpendChart
            range={range}
            overview={chart.data}
            loading={chart.isPending}
            palette={palette}
            currency={currency}
            filters={filters}
            onDay={(day) => onFilter("day", day)}
            onModel={onModel}
          />

          <Breakdown
            range={range}
            filters={filters}
            currency={currency}
            palette={palette}
            onFilter={onFilter}
            onModel={onModel}
          />

          <Runs range={range} filters={filters} currency={currency} palette={palette} />
        </>
      )}
    </div>
  )
}

interface HeroProps {
  readonly loading: boolean
  readonly overview: Overview | undefined
  readonly prior: Overview | undefined
  readonly all: Overview | undefined
  readonly narrowed: boolean
  readonly currency: string
  readonly priorLabel: string
  readonly limitsHref: string
  readonly runsQuery: Parameters<typeof useRunsTotal>[0]
}

function Hero({
  loading,
  overview,
  prior,
  all,
  narrowed,
  currency,
  priorLabel,
  limitsHref,
  runsQuery,
}: HeroProps) {
  const messages = useAiUsageMessages().hero
  const locale = useLocale()
  const runs = useRunsTotal(runsQuery)
  const budget = useProjectBudget(currency)

  if (loading || !overview) {
    return (
      <Panel>
        <PanelSkeleton rows={3} />
      </Panel>
    )
  }

  const totals = overview.totals
  const cost = costOf(totals, currency)
  const before = costOf(prior?.totals, currency)
  const delta = cost - before
  const { whole, cents } = splitMoney(cost, currency, locale)
  const share = all ? cost / (costOf(all.totals, currency) || 1) : undefined

  return (
    <section className="flex flex-wrap items-end gap-x-12 gap-y-7">
      <div className="min-w-0 flex-[1_1_300px]">
        <div className="text-xs font-medium text-muted-foreground">
          {narrowed ? messages.spentFiltered : messages.spent}
        </div>
        <div className="mt-2 text-[3.75rem] font-semibold leading-none tracking-[-0.04em] tabular-nums">
          {whole}
          <span className="text-muted-foreground/60">{cents}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted-foreground">
          {prior ? (
            <>
              <span className="inline-flex h-[22px] items-center rounded-md bg-muted px-2 font-medium text-foreground tabular-nums">
                {delta >= 0 ? "↑ " : "↓ "}
                {money(Math.abs(delta), currency, locale)}
              </span>
              <span>{messages.versus(priorLabel)}</span>
            </>
          ) : null}
          {narrowed && share !== undefined ? (
            <span>{messages.shareOfAll(percent(share, locale))}</span>
          ) : null}
        </div>
        {!narrowed && budget ? (
          <Link
            to={limitsHref}
            className="mt-3.5 flex max-w-[380px] items-center gap-2.5 text-[0.8125rem] text-muted-foreground"
          >
            <span className="h-1 w-full max-w-[120px] flex-1 overflow-hidden rounded-sm bg-muted">
              <span
                className="block h-full rounded-sm bg-foreground"
                style={{ width: `${Math.min(100, (budget.used / (budget.limit || 1)) * 100)}%` }}
              />
            </span>
            <span className="tabular-nums">
              <span className="font-medium text-foreground">
                {money(budget.used, currency, locale)}
              </span>{" "}
              {messages.budgetOf(budget.limitLabel, budget.month)}
            </span>
          </Link>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-9 gap-y-6">
        <Stat
          label={messages.tokens}
          value={compact(totals.usage.totalTokens, locale)}
          detail={messages.cached(percent(cachedShare(totals.usage), locale))}
        />
        <span className="w-px self-stretch bg-border/70" />
        <Stat
          label={messages.calls}
          value={totals.modelCallCount.toLocaleString(locale)}
          detail={messages.perCall(
            fineMoney(
              totals.modelCallCount > 0 ? cost / totals.modelCallCount : 0,
              currency,
              locale
            )
          )}
        />
        <span className="w-px self-stretch bg-border/70" />
        <Stat
          label={messages.runs}
          value={runs === undefined ? "—" : runs.toLocaleString(locale)}
          detail={messages.perRun(fineMoney(runs ? cost / runs : 0, currency, locale))}
        />
      </div>
    </section>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex min-w-[120px] flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-[1.625rem] font-semibold leading-[1.1] tracking-[-0.02em] tabular-nums">
        {value}
      </span>
      <span className="text-[0.8125rem] text-muted-foreground tabular-nums">{detail}</span>
    </div>
  )
}

/** This month's project-wide cost limit and what it has used, when there is one. */
function useProjectBudget(currency: string) {
  const locale = useLocale()
  const { data } = useQuery({ ...getAiLimitStatusOptions(limitStatusQuery), retry: false })
  const status = data?.items.find(
    (item) =>
      item.policy.enabled &&
      item.policy.subject.type === "project" &&
      item.policy.limit.meter === "cost.catalogEstimated" &&
      item.policy.limit.amount.currency === currency
  )
  if (!status || status.policy.limit.meter !== "cost.catalogEstimated") return undefined
  const used =
    status.consumption.actual.meter === "cost.catalogEstimated"
      ? Number(status.consumption.actual.amount.amountNanos) / 1e9
      : 0
  const limit = Number(status.policy.limit.amount.amountNanos) / 1e9
  return {
    used,
    limit,
    // A round limit reads without cents.
    limitLabel: Number.isInteger(limit)
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          maximumFractionDigits: 0,
        }).format(limit)
      : money(limit, currency, locale),
    month: new Date(status.period.start).toLocaleDateString(locale, {
      month: "long",
      timeZone: "UTC",
    }),
  }
}

/** Every model's spend in every period of the range, as the chart and the filters narrow it. */
function ExportButton({ range, filters }: { range: SpendRange; filters: SpendFilters }) {
  const messages = useAiUsageMessages()
  const { data } = useQuery({
    ...getAiAccountingOverviewOptions({
      query: { from: range.from, to: range.to, bucket: range.bucket, ...apiFilters(filters) },
    }),
    retry: false,
  })
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={messages.export}
      title={messages.export}
      disabled={!data}
      onClick={() => {
        if (!data) return
        const rows: (string | number)[][] = [
          ["period", "provider", "model", "calls", "tokens", "currency", "cost"],
        ]
        for (const model of data.modelSeries) {
          for (const period of model.series) {
            if (period.modelCallCount === 0) continue
            for (const amount of period.costs.amounts.length > 0
              ? period.costs.amounts
              : [{ currency: "", amountNanos: "0" }]) {
              rows.push([
                period.start,
                model.providerId,
                model.modelId,
                period.modelCallCount,
                period.usage.totalTokens ?? "",
                amount.currency,
                (Number(amount.amountNanos) / 1e9).toFixed(9),
              ])
            }
          }
        }
        downloadCsv(`usage-${range.from.slice(0, 10)}-${range.to.slice(0, 10)}.csv`, rows)
      }}
    >
      <Download />
    </Button>
  )
}
