import { getAiAccountingOverviewOptions } from "@sixb/client/hooks"
import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { PanelSkeleton } from "../../section-ui"
import { personValue, useNames } from "./filter-menu"
import type { Overview } from "./format"
import { useAiUsageMessages } from "./messages"
import { Segmented } from "./segmented"
import {
  type Aggregate,
  activeRange,
  apiFilters,
  cachedShare,
  colorOf,
  compact,
  costOf,
  type FilterKey,
  modelKey,
  money,
  otherModelColor,
  percent,
  priorRange,
  type SpendFilters,
  type SpendRange,
  sharePercent,
  signedMoney,
} from "./spend-model"

type Lens = "model" | "source" | "person" | "kind"

/** The most rows a lens lists one by one; the rest fold into one. */
const rowLimit = 10

interface Row {
  readonly key: string
  readonly name: string
  readonly detail: string
  /** A model's color, or the initials on a row's tile. */
  readonly color?: string
  readonly initials?: string
  /** The filters that narrow the page to this row. */
  readonly narrow: Pick<SpendFilters, "provider" | "model" | "person" | "source" | "kind">
  readonly selected: boolean
}

const initialsOf = (name: string) =>
  name
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("") || "?"

/**
 * The range's spend by model, source, person or kind. Each lens lists its rows unfiltered by its
 * own dimension, so picking a row highlights it among the others instead of hiding them.
 */
export function Breakdown({
  range,
  filters,
  currency,
  palette,
  onFilter,
  onModel,
}: {
  readonly range: SpendRange
  readonly filters: SpendFilters
  readonly currency: string
  readonly palette: ReadonlyMap<string, string>
  readonly onFilter: (key: FilterKey, value: string | undefined) => void
  readonly onModel: (model: { providerId: string; modelId: string } | undefined) => void
}) {
  const messages = useAiUsageMessages().breakdown
  const names = useNames()
  const locale = useLocale()
  const [lens, setLens] = useState<Lens>("model")

  // Every filter but the lens's own.
  const others: SpendFilters = {
    ...filters,
    ...(lens === "model" ? { provider: undefined, model: undefined } : { [lens]: undefined }),
  }
  const active = activeRange(range, filters)
  const base = useQuery({
    ...getAiAccountingOverviewOptions({
      query: { ...active, bucket: range.bucket, ...apiFilters(others) },
    }),
    retry: false,
  })
  const rows = base.data
    ? rowsFor(lens, base.data, filters, palette, currency, names, messages)
    : []
  const shown = rows.slice(0, rowLimit)

  // Each row's own series over the whole range, for its bars by day, and its prior period.
  const series = useQueries({
    queries: shown.map((row) => ({
      ...getAiAccountingOverviewOptions({
        query: {
          from: range.from,
          to: range.to,
          bucket: range.bucket,
          ...apiFilters({ ...others, ...row.narrow, day: undefined }),
        },
      }),
      retry: false,
    })),
  })
  const priors = useQueries({
    queries: shown.map((row) => ({
      ...getAiAccountingOverviewOptions({
        query: {
          ...priorRange(active),
          bucket: range.bucket,
          ...apiFilters({ ...others, ...row.narrow }),
        },
      }),
      enabled: !filters.day,
      retry: false,
    })),
  })

  const measured = shown.map((row, index) => {
    const data = series[index]?.data
    // A picked day is one of the row's own periods.
    const aggregate: Aggregate | undefined = filters.day
      ? data?.series.find((period) => period.start === filters.day)
      : data?.totals
    return { row, data, aggregate, prior: priors[index]?.data?.totals }
  })
  const visible = measured
    .filter(({ row, aggregate }) => row.selected || !aggregate || aggregate.modelCallCount > 0)
    .sort((a, b) => costOf(b.aggregate, currency) - costOf(a.aggregate, currency))
  const listed = visible.reduce((sum, { aggregate }) => sum + costOf(aggregate, currency), 0)
  const restCost =
    rows.length > rowLimit ? Math.max(0, costOf(base.data?.totals, currency) - listed) : 0
  const totalCost = listed + restCost || 1
  const maxShare = Math.max(
    0,
    ...visible.map(({ aggregate }) => costOf(aggregate, currency) / totalCost),
    restCost / totalCost
  )
  const anySelected = rows.some((row) => row.selected)

  const pick = (row: Row) => {
    if (lens === "model") {
      onModel(
        row.narrow.provider && row.narrow.model
          ? { providerId: row.narrow.provider, modelId: row.narrow.model }
          : undefined
      )
      return
    }
    onFilter(lens, row.narrow[lens])
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border/80 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3.5">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">{messages.title}</h2>
          <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            {messages.descriptions[lens]}
          </div>
        </div>
        <Segmented
          label={messages.title}
          value={lens}
          options={(["model", "source", "person", "kind"] as const).map((value) => ({
            value,
            label: messages.lenses[value],
          }))}
          onChange={setLens}
        />
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[900px]">
          <div className={cn(gridRow, "min-h-[38px] text-xs font-medium text-muted-foreground")}>
            <span>{messages.lenses[lens]}</span>
            <span className="text-right">{messages.columns.calls}</span>
            <span className="text-right">{messages.columns.tokens}</span>
            <span className="text-right">{messages.columns.cached}</span>
            <span className="text-right">{messages.columns.cost}</span>
            <span className="text-right">{filters.day ? "" : messages.columns.versus}</span>
            <span>{messages.columns.share}</span>
            <span className="text-right">{messages.columns.trend}</span>
          </div>
          {base.isPending ? (
            <PanelSkeleton rows={4} />
          ) : visible.length === 0 ? (
            <div className="border-t border-border/50 px-5 py-8 text-center text-sm text-muted-foreground">
              {messages.empty}
            </div>
          ) : (
            visible.map(({ row, data, aggregate, prior }) => {
              const cost = costOf(aggregate, currency)
              const before = costOf(prior, currency)
              const share = cost / totalCost
              const trend = data?.series ?? []
              const trendMax = Math.max(0, ...trend.map((period) => costOf(period, currency)))
              return (
                <div
                  key={row.key}
                  role="button"
                  tabIndex={0}
                  aria-pressed={row.selected}
                  onClick={() => pick(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      pick(row)
                    }
                  }}
                  className={cn(
                    gridRow,
                    "min-h-[54px] cursor-pointer border-t border-border/50 transition-[opacity,background-color] hover:bg-muted/40",
                    row.selected && "bg-muted/60",
                    anySelected && !row.selected && "opacity-[0.42] hover:opacity-80"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {row.color ? (
                      <span
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={{ background: row.color }}
                      />
                    ) : (
                      <span className="flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-muted text-[0.6875rem] font-semibold text-muted-foreground">
                        {row.initials}
                      </span>
                    )}
                    <span className="flex min-w-0 flex-col leading-[1.3]">
                      <span className="truncate font-medium">{row.name}</span>
                      {row.detail ? (
                        <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="text-right text-foreground/80 tabular-nums">
                    {aggregate ? aggregate.modelCallCount.toLocaleString(locale) : "—"}
                  </span>
                  <span className="text-right text-foreground/80 tabular-nums">
                    {compact(aggregate?.usage.totalTokens, locale)}
                  </span>
                  <span className="text-right text-foreground/80 tabular-nums">
                    {aggregate ? percent(cachedShare(aggregate.usage), locale) : "—"}
                  </span>
                  <span className="text-right font-semibold tabular-nums">
                    {aggregate ? money(cost, currency, locale) : "—"}
                  </span>
                  <span className="text-right text-[0.8125rem] text-muted-foreground tabular-nums">
                    {filters.day || !prior
                      ? ""
                      : before === 0 && cost > 0
                        ? messages.new
                        : signedMoney(cost - before, currency, locale)}
                  </span>
                  <span className="flex items-center gap-2.5">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-muted">
                      <span
                        className="block h-full rounded-[3px] bg-foreground"
                        style={{ width: `${maxShare > 0 ? (share / maxShare) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="w-11 text-right text-[0.78rem] text-muted-foreground tabular-nums">
                      {aggregate ? sharePercent(share, locale) : ""}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "flex h-5 items-end justify-end",
                      trend.length > 8 ? "gap-px" : "gap-0.5"
                    )}
                  >
                    {trend.map((period) => (
                      <span
                        key={period.start}
                        className="block rounded-[1.5px]"
                        style={{
                          width: Math.max(1, Math.min(5, (64 - trend.length) / trend.length)),
                          height: Math.max(
                            1.5,
                            trendMax > 0 ? (costOf(period, currency) / trendMax) * 20 : 1.5
                          ),
                          background:
                            lens === "model"
                              ? row.color === otherModelColor
                                ? "#b3b3ae"
                                : row.color
                              : "#9a9a9a",
                          opacity: filters.day && filters.day !== period.start ? 0.3 : 1,
                        }}
                      />
                    ))}
                  </span>
                </div>
              )
            })
          )}
          {rows.length > rowLimit ? (
            <div
              className={cn(
                gridRow,
                "min-h-[54px] border-t border-border/50 text-muted-foreground"
              )}
            >
              <span className="flex items-center gap-2.5">
                <span className="flex size-[22px] items-center justify-center rounded-[7px] bg-muted text-[0.6875rem] font-semibold">
                  +
                </span>
                <span className="font-medium">{messages.more(rows.length - rowLimit)}</span>
              </span>
              <span />
              <span />
              <span />
              <span className="text-right font-semibold text-foreground tabular-nums">
                {money(restCost, currency, locale)}
              </span>
              <span />
              <span className="flex items-center gap-2.5">
                <span className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-muted">
                  <span
                    className="block h-full rounded-[3px] bg-foreground"
                    style={{
                      width: `${maxShare > 0 ? (restCost / totalCost / maxShare) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="w-11 text-right text-[0.78rem] tabular-nums">
                  {sharePercent(restCost / totalCost, locale)}
                </span>
              </span>
              <span />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

const gridRow =
  "grid grid-cols-[minmax(220px,2.2fr)_64px_72px_64px_84px_80px_minmax(120px,1.2fr)_64px] items-center gap-4 px-5"

function rowsFor(
  lens: Lens,
  overview: Overview,
  filters: SpendFilters,
  palette: ReadonlyMap<string, string>,
  currency: string,
  names: ReturnType<typeof useNames>,
  messages: ReturnType<typeof useAiUsageMessages>["breakdown"]
): Row[] {
  const byCost = <T extends Aggregate>(items: readonly T[]) =>
    [...items].sort(
      (a, b) => costOf(b, currency) - costOf(a, currency) || b.modelCallCount - a.modelCallCount
    )
  switch (lens) {
    case "model":
      return byCost(overview.models).map((model) => ({
        key: modelKey(model),
        name: model.modelId,
        detail: model.providerId,
        color: colorOf(palette, modelKey(model)),
        narrow: { provider: model.providerId, model: model.modelId },
        selected: filters.provider === model.providerId && filters.model === model.modelId,
      }))
    case "person":
      return byCost(overview.people).map((person) => {
        const value = personValue(person.requester)
        const name = names.person(person.requester)
        return {
          key: value,
          name,
          detail: !person.requester
            ? messages.nobodyDetail
            : person.requester.type === "serviceAccount"
              ? messages.serviceAccount
              : (person.requester.email ?? ""),
          initials: initialsOf(name),
          narrow: { person: value },
          selected: filters.person === value,
        }
      })
    case "kind":
      return byCost(overview.kinds).flatMap((kind) =>
        kind.modelKind
          ? [
              {
                key: kind.modelKind,
                name: names.kind(kind.modelKind),
                detail: "",
                initials: initialsOf(names.kind(kind.modelKind)),
                narrow: { kind: kind.modelKind },
                selected: filters.kind === kind.modelKind,
              },
            ]
          : []
      )
    case "source": {
      const sources: { value: string; detail: string }[] = [
        ...(overview.agents.some((agent) => agent.kind === "agent")
          ? [{ value: "agent", detail: messages.chatsDetail }]
          : []),
        ...byCost(overview.workflows).map((workflow) => ({
          value: `workflow:${workflow.workflowId}`,
          detail: messages.workflow,
        })),
        { value: "action", detail: messages.actionsDetail },
        { value: "other", detail: messages.otherDetail },
      ]
      return sources.map(({ value, detail }) => ({
        key: value,
        name: names.source(value),
        detail,
        initials: value.startsWith("workflow:") ? "W" : initialsOf(names.source(value)),
        narrow: { source: value },
        selected: filters.source === value,
      }))
    }
  }
}
