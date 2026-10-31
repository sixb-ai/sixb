import { useLocale } from "@sixb/ui/lib/i18n"
import { cn } from "@sixb/ui/lib/utils"
import { useState } from "react"
import type { Overview } from "./format"
import { useAiUsageMessages } from "./messages"
import { Segmented } from "./segmented"
import {
  type Aggregate,
  bucketLabel,
  colorOf,
  compact,
  costOf,
  modelKey,
  money,
  niceScale,
  otherModelColor,
  percent,
  type SpendFilters,
  type SpendRange,
} from "./spend-model"

export type Measure = "cost" | "tokens" | "calls"

const height = 232

interface Series {
  readonly key: string
  readonly name: string
  readonly color: string
  readonly model?: { readonly providerId: string; readonly modelId: string }
  readonly values: readonly number[]
}

/**
 * Spend, tokens or calls per period, stacked by model. A model keeps its color everywhere on the
 * page; the rest share one gray. Clicking a bar narrows the page to that period, and a legend
 * entry to that model.
 */
export function SpendChart({
  range,
  overview,
  loading,
  palette,
  currency,
  filters,
  onDay,
  onModel,
}: {
  readonly range: SpendRange
  readonly overview: Overview | undefined
  readonly loading: boolean
  readonly palette: ReadonlyMap<string, string>
  readonly currency: string
  readonly filters: SpendFilters
  readonly onDay: (day: string | undefined) => void
  readonly onModel: (model: { providerId: string; modelId: string }) => void
}) {
  const messages = useAiUsageMessages().chart
  const locale = useLocale()
  const [measure, setMeasure] = useState<Measure>("cost")
  // The hovered period and model. The bar's own label reads them out; the legend only
  // highlights, never changes size, or the bars would move out from under the pointer.
  const [hover, setHover] = useState<number>()
  const [hoverSeries, setHoverSeries] = useState<string>()

  const titles =
    range.bucket === "hour"
      ? messages.hourTitles
      : range.bucket === "week"
        ? messages.weekTitles
        : messages.titles

  const periods = overview?.series ?? []
  const measureOf = (aggregate: Aggregate) =>
    measure === "cost"
      ? costOf(aggregate, currency)
      : measure === "tokens"
        ? (aggregate.usage.totalTokens ?? 0)
        : aggregate.modelCallCount
  const format = (value: number) =>
    measure === "cost"
      ? money(value, currency, locale)
      : measure === "tokens"
        ? compact(value, locale)
        : Math.round(value).toLocaleString(locale)

  // The palette's models one by one, the rest together, in the palette's order.
  const colored = [...palette.keys()]
  const series: Series[] = []
  const rest = periods.map(() => 0)
  let restCount = 0
  for (const model of overview?.modelSeries ?? []) {
    const values = model.series.map(measureOf)
    if (palette.has(modelKey(model))) {
      series.push({
        key: modelKey(model),
        name: model.modelId,
        color: colorOf(palette, modelKey(model)),
        model,
        values,
      })
    } else {
      restCount++
      values.forEach((value, index) => {
        rest[index] = (rest[index] ?? 0) + value
      })
    }
  }
  series.sort((a, b) => colored.indexOf(a.key) - colored.indexOf(b.key))
  if (restCount > 0) {
    series.push({
      key: "other",
      name:
        restCount === 1
          ? (overview?.modelSeries.find((m) => !palette.has(modelKey(m)))?.modelId ?? "")
          : messages.otherModels(restCount),
      color: otherModelColor,
      values: rest,
    })
  }

  const stacks = periods.map((_, index) =>
    series.reduce((total, entry) => total + (entry.values[index] ?? 0), 0)
  )
  const max = Math.max(0, ...stacks)
  const { step, top } = niceScale(max)
  const tick = (value: number) =>
    measure === "cost"
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          maximumFractionDigits: step < 1 ? 2 : 0,
        }).format(value)
      : measure === "tokens"
        ? compact(value, locale)
        : Math.round(value).toLocaleString(locale)
  const peak = max > 0 ? stacks.indexOf(max) : -1
  const total = stacks.reduce((sum, value) => sum + value, 0)
  const every = Math.max(1, Math.ceil(periods.length / 8))
  const picked = filters.day ? periods.findIndex((period) => period.start === filters.day) : -1
  const modelFiltered = filters.model !== undefined

  return (
    <section className="rounded-2xl border border-border/80 bg-card px-[22px] pt-5 pb-[18px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[0.9375rem] font-semibold">{titles[measure]}</h2>
          <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">
            {messages.subtitles[measure]}
          </div>
        </div>
        <Segmented
          label={messages.measures.cost}
          value={measure}
          options={(["cost", "tokens", "calls"] as const).map((value) => ({
            value,
            label: messages.measures[value],
          }))}
          onChange={setMeasure}
        />
      </div>

      <div className="mt-3.5 -ml-2 flex min-h-7 flex-wrap items-center gap-x-1 gap-y-0.5">
        {series.map((entry) => {
          const on =
            entry.model !== undefined &&
            filters.provider === entry.model.providerId &&
            filters.model === entry.model.modelId
          const sum = entry.values.reduce((a, b) => a + b, 0)
          const content = (
            <>
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: entry.color }}
              />
              <span className="text-foreground/80">{entry.name}</span>
              <span className="font-medium tabular-nums">{sum > 0 ? format(sum) : "—"}</span>
            </>
          )
          const className = cn(
            "inline-flex h-7 items-center gap-[7px] rounded-lg pr-2.5 pl-2 text-[0.8125rem] transition-opacity",
            (on || hoverSeries === entry.key) && "bg-muted",
            ((modelFiltered && !on) || (hoverSeries !== undefined && hoverSeries !== entry.key)) &&
              "opacity-45"
          )
          return entry.model ? (
            <button
              key={entry.key}
              type="button"
              aria-pressed={on}
              onClick={() => entry.model && onModel(entry.model)}
              className={cn(className, "transition-colors hover:bg-muted/70")}
            >
              {content}
            </button>
          ) : (
            <span key={entry.key} className={className}>
              {content}
            </span>
          )
        })}
      </div>

      <div className="relative mt-[34px] ml-[52px]" style={{ height }}>
        {[0, 1, 2, 3, 4].map((line) => (
          <div
            key={line}
            className={cn(
              "absolute inset-x-0 border-t",
              line === 0 ? "border-border" : "border-border/40"
            )}
            style={{ bottom: ((line * step) / top) * height }}
          >
            <span className="absolute -top-[9px] -left-[52px] w-[42px] text-right text-[0.6875rem] text-muted-foreground tabular-nums">
              {tick(line * step)}
            </span>
          </div>
        ))}
        {loading ? null : (
          <div
            className={cn("absolute inset-0 flex", periods.length > 14 ? "gap-0.5" : "gap-1.5")}
            onMouseLeave={() => {
              setHover(undefined)
              setHoverSeries(undefined)
            }}
          >
            {periods.map((period, index) => {
              const stack = stacks[index] ?? 0
              const isPicked = picked === index
              const isHover = hover === index
              const values = series.map((entry) => entry.values[index] ?? 0)
              const last = values.reduce((top, value, at) => (value > 0 ? at : top), -1)
              const label = bucketLabel(period.start, range.bucket, locale)
              const segmentIndex = series.findIndex((entry) => entry.key === hoverSeries)
              const hoveredSegment = segmentIndex >= 0 ? segmentIndex : undefined
              return (
                <button
                  key={period.start}
                  type="button"
                  aria-pressed={isPicked}
                  aria-label={`${label}, ${format(stack)}`}
                  onClick={() => onDay(isPicked ? undefined : period.start)}
                  onMouseEnter={() => setHover(index)}
                  onFocus={() => setHover(index)}
                  onBlur={() => setHover(undefined)}
                  className="relative flex h-full flex-1 items-end justify-center outline-none"
                >
                  <span
                    className="relative flex w-[44%] max-w-[46px] flex-col-reverse gap-0.5 transition-opacity duration-150"
                    style={{
                      opacity:
                        hover !== undefined
                          ? isHover
                            ? 1
                            : 0.4
                          : picked >= 0 && !isPicked
                            ? 0.28
                            : 1,
                    }}
                  >
                    {values.map((value, segment) =>
                      value > 0 ? (
                        <span
                          key={series[segment]!.key}
                          className="block transition-opacity duration-150"
                          onMouseEnter={() => setHoverSeries(series[segment]!.key)}
                          onMouseLeave={() => setHoverSeries(undefined)}
                          style={{
                            height: Math.max(2, (value / top) * height),
                            background: series[segment]!.color,
                            borderRadius: segment === last ? "4px 4px 1px 1px" : "1px",
                            opacity:
                              isHover &&
                              hoverSeries !== undefined &&
                              hoverSeries !== series[segment]!.key
                                ? 0.45
                                : 1,
                          }}
                        />
                      ) : null
                    )}
                    {/* The hovered bar names its day and total, or the hovered model's share; with
                    none hovered, the peak names its total. */}
                    {isHover || (hover === undefined && picked < 0 && index === peak) ? (
                      <span className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap text-xs font-medium tabular-nums">
                        {isHover && hoveredSegment !== undefined ? (
                          <>
                            <span className="font-normal text-muted-foreground">
                              {series[hoveredSegment]!.name}{" "}
                            </span>
                            {format(values[hoveredSegment] ?? 0)}
                          </>
                        ) : stack > 0 ? (
                          format(stack)
                        ) : (
                          "—"
                        )}
                        <span className="font-normal text-muted-foreground">
                          {" · "}
                          {isHover
                            ? label
                            : messages.shareOf(
                                percent(stack / (total || 1), locale),
                                messages.periods[range.period]
                              )}
                        </span>
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <div className={cn("mt-2.5 ml-[52px] flex", periods.length > 14 ? "gap-0.5" : "gap-1.5")}>
        {periods.map((period, index) => (
          <span
            key={period.start}
            className={cn(
              "flex-1 overflow-visible whitespace-nowrap text-center text-xs",
              picked === index || hover === index ? "text-foreground" : "text-muted-foreground",
              picked === index && "font-semibold"
            )}
          >
            {index % every === 0 || picked === index || hover === index
              ? bucketLabel(period.start, range.bucket, locale)
              : ""}
          </span>
        ))}
      </div>
    </section>
  )
}
