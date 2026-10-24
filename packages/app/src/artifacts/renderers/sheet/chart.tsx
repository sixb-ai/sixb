import type { WorkbookChart } from "@sixb/core/artifacts"
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@sixb/ui/components"
import { memo, useMemo } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts"
import { useArtifactMessages } from "../../messages"
import { chartData, chartLockedColumns, latestValue } from "./chart-data"
import { ChartLocked } from "./chart-locked"
import { cellFormatter, compactFormatter } from "./format"
import type { SheetModel } from "./model"

/**
 * Every chart in a sheet, drawn by Sixb from the sheet's data: the theme's chart colors, axes and
 * tooltips formatted as the columns are, a legend only when there are several series, and the
 * latest value labelled. A bar chart draws its line columns over the bars, on a right axis when
 * they are of another kind; a scatter places each row by two numbers and names it on hover. Loaded on demand, so a sheet without charts never fetches it, and drawn
 * again only when its data changes: the grid beside it re-renders on every move of the selection.
 */
export default memo(function SheetChart({
  chart,
  model,
  locale,
}: {
  readonly chart: WorkbookChart
  readonly model: SheetModel
  readonly locale: string
}) {
  const messages = useArtifactMessages().sheet
  const countLabel = messages.count
  const locked = useMemo(() => chartLockedColumns(chart, model), [chart, model])
  const data = useMemo(
    () => (locked.length > 0 ? null : chartData(chart, model, countLabel)),
    [locked, chart, model, countLabel]
  )
  const config = useMemo<ChartConfig>(
    () =>
      Object.fromEntries(
        (data?.series ?? []).map((series) => [
          series.key,
          { label: series.label, color: series.color },
        ])
      ),
    [data]
  )
  if (locked.length > 0) return <ChartLocked label={messages.chartLocked(locked)} />
  if (!data) return null

  const [first] = data.series
  if (!first) return null
  const axis = compactFormatter(first.column, locale)
  const values = Object.fromEntries(
    data.series.map((series) => [series.key, cellFormatter(series.column, locale)])
  )
  const formatValue = (value: unknown, key: string) =>
    typeof value === "number" ? (values[key]?.(String(value)).text ?? String(value)) : String(value)
  const x = cellFormatter(data.x, locale)
  const formatX = (value: unknown) => x(String(value)).text
  const lastIndex = data.rows.length - 1
  const several = data.series.length > 1
  // Straight segments between the values there are; a few points also show as dots.
  const dots = data.rows.length <= 24
  // Stacked series are labelled once, with their total, at the top of the stack.
  const labelled = chart.stacked ? data.series.at(-1) : first
  const latest = latestValue(data, Boolean(chart.stacked))

  const tooltip = (
    <ChartTooltip
      cursor={chart.type === "bar" ? { fill: "var(--muted)", opacity: 0.6 } : true}
      content={
        <ChartTooltipContent
          labelFormatter={(label) => formatX(label)}
          formatter={(value, name, item) => (
            <span className="flex w-full items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-[2px]" style={{ background: item.color }} />
                {config[String(name)]?.label}
              </span>
              <span className="font-medium text-foreground tabular-nums">
                {formatValue(value, String(name))}
              </span>
            </span>
          )}
        />
      }
    />
  )
  const lastLabel = (key: string) => (
    <LabelList
      dataKey={key}
      content={(props) => {
        const { index, x, y, width, value } = props as {
          index?: number
          x?: number | string
          y?: number | string
          width?: number | string
          value?: unknown
        }
        if (index !== lastIndex || typeof value !== "number" || latest === null) return null
        const left = Number(x ?? 0) + Number(width ?? 0) / 2
        return (
          <text
            x={left}
            y={Number(y ?? 0) - 8}
            textAnchor="middle"
            className="fill-foreground text-[11px] font-semibold tabular-nums"
          >
            {axis(latest)}
          </text>
        )
      }}
    />
  )
  const cartesian = {
    data: data.rows as Record<string, string | number | null>[],
    margin: { top: 24, right: 12, bottom: 0, left: 0 },
    accessibilityLayer: true,
  }
  const axes = (
    <>
      <CartesianGrid vertical={false} strokeDasharray="0" />
      <XAxis
        dataKey="x"
        tickLine={false}
        axisLine={false}
        tickMargin={10}
        minTickGap={chart.type === "bar" ? 4 : 16}
        tickFormatter={formatX}
      />
      {/* A line shows change, so its axis fits the values; bars and areas measure from zero. */}
      <YAxis
        tickLine={false}
        axisLine={false}
        tickMargin={6}
        width={56}
        tickFormatter={axis}
        {...(chart.type === "line" ? { domain: ["auto", "auto"] } : {})}
      />
    </>
  )
  const legend = several ? (
    <ChartLegend
      verticalAlign="top"
      align="left"
      content={<ChartLegendContent className="justify-start pb-3" />}
    />
  ) : null

  if (chart.type === "pie") {
    const slices = data.rows.flatMap((row, index) => {
      const value = row[first.key]
      return typeof value === "number" && value > 0
        ? [{ label: formatX(row.x), value, color: `var(--chart-${(index % 5) + 1})` }]
        : []
    })
    const total = slices.reduce((sum, slice) => sum + slice.value, 0)
    const share = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })
    return (
      <div className="flex h-full min-h-0 w-full flex-col gap-3">
        <ChartContainer config={config} className="aspect-auto min-h-0 w-full flex-1">
          <PieChart accessibilityLayer>
            <ChartTooltip
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(value, name) => (
                    <span className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{String(name)}</span>
                      <span className="font-medium text-foreground tabular-nums">
                        {formatValue(value, first.key)}
                      </span>
                    </span>
                  )}
                />
              }
            />
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="56%"
              outerRadius="88%"
              paddingAngle={1.5}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {/* By position: two slices can share a label. */}
              {slices.map((slice, index) => (
                <Cell key={index} fill={slice.color} />
              ))}
            </Pie>
          </PieChart>
        </ChartContainer>
        {/* The legend names each slice with its value and share; the chart's colors alone don't. */}
        <ul className="mx-auto my-0 grid w-full max-w-sm shrink-0 list-none gap-1.5 p-0 text-xs">
          {slices.map((slice, index) => (
            <li key={index} className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ background: slice.color }} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{slice.label}</span>
              <span className="font-medium text-foreground tabular-nums">
                {formatValue(slice.value, first.key)}
              </span>
              <span className="w-9 text-right text-muted-foreground tabular-nums">
                {share.format(total > 0 ? slice.value / total : 0)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  if (chart.type === "scatter") {
    const formatY = compactFormatter(first.column, locale)
    const xAxis = compactFormatter(data.x, locale)
    return (
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <ScatterChart margin={{ top: 16, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid strokeDasharray="0" />
          <XAxis
            type="number"
            dataKey="x"
            name={data.x.name}
            domain={["auto", "auto"]}
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            tickFormatter={xAxis}
          />
          <YAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            width={56}
            domain={["auto", "auto"]}
            tickFormatter={formatY}
          />
          <ChartTooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              const point = payload?.[0]?.payload as Record<string, unknown> | undefined
              if (!active || !point) return null
              return (
                <div className="grid min-w-36 gap-1 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                  {point.name ? <span className="font-medium">{String(point.name)}</span> : null}
                  {[
                    { label: data.x.name, text: formatX(point.x) },
                    ...data.series.map((series) => ({
                      label: series.label,
                      text: formatValue(point[series.key], series.key),
                    })),
                  ].map((entry) => (
                    <span key={entry.label} className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{entry.label}</span>
                      <span className="font-medium tabular-nums">{entry.text}</span>
                    </span>
                  ))}
                </div>
              )
            }}
          />
          {legend}
          {data.series.map((series) => (
            <Scatter
              key={series.key}
              name={series.label}
              data={data.rows as Record<string, string | number | null>[]}
              dataKey={series.key}
              fill={`var(--color-${series.key})`}
              fillOpacity={0.85}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ChartContainer>
    )
  }

  const lines = data.series.filter((series) => series.line)
  if (chart.type === "bar" && lines.length > 0) {
    const bars = data.series.filter((series) => !series.line)
    const right = lines.find((series) => series.right)
    return (
      <ChartContainer config={config} className="aspect-auto h-full w-full">
        <ComposedChart {...cartesian} barCategoryGap="22%">
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis
            dataKey="x"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            minTickGap={4}
            tickFormatter={formatX}
          />
          <YAxis
            yAxisId="left"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            width={56}
            tickFormatter={axis}
          />
          {/* Lines of another kind than the bars, a percent over amounts, read on their own axis. */}
          {right ? (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={48}
              domain={["auto", "auto"]}
              tickFormatter={compactFormatter(right.column, locale)}
            />
          ) : null}
          {tooltip}
          {legend}
          {bars.map((series, index) => (
            <Bar
              key={series.key}
              yAxisId="left"
              dataKey={series.key}
              fill={`var(--color-${series.key})`}
              radius={chart.stacked && index < bars.length - 1 ? 0 : [4, 4, 0, 0]}
              maxBarSize={56}
              isAnimationActive={false}
              {...(chart.stacked ? { stackId: "stack" } : {})}
            />
          ))}
          {lines.map((series) => (
            <Line
              key={series.key}
              yAxisId={series.right ? "right" : "left"}
              dataKey={series.key}
              type="linear"
              stroke={`var(--color-${series.key})`}
              strokeWidth={2.25}
              dot={{ r: 3, strokeWidth: 2, fill: "var(--background)" }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ChartContainer>
    )
  }

  return (
    <ChartContainer config={config} className="aspect-auto h-full w-full">
      {chart.type === "line" ? (
        <LineChart {...cartesian}>
          {axes}
          {tooltip}
          {legend}
          {data.series.map((series) => (
            <Line
              key={series.key}
              dataKey={series.key}
              type="linear"
              stroke={`var(--color-${series.key})`}
              strokeWidth={2}
              dot={dots ? { r: 2.5, strokeWidth: 0, fill: `var(--color-${series.key})` } : false}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            >
              {series === labelled ? lastLabel(series.key) : null}
            </Line>
          ))}
        </LineChart>
      ) : chart.type === "area" ? (
        <AreaChart {...cartesian}>
          {axes}
          {tooltip}
          {legend}
          {data.series.map((series) => (
            <Area
              key={series.key}
              dataKey={series.key}
              type="linear"
              stroke={`var(--color-${series.key})`}
              strokeWidth={2}
              fill={`var(--color-${series.key})`}
              fillOpacity={0.12}
              isAnimationActive={false}
              {...(chart.stacked ? { stackId: "stack" } : {})}
            >
              {series === labelled ? lastLabel(series.key) : null}
            </Area>
          ))}
        </AreaChart>
      ) : (
        <BarChart {...cartesian} barCategoryGap="22%">
          {axes}
          {tooltip}
          {legend}
          {data.series.map((series, index) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              fill={`var(--color-${series.key})`}
              radius={chart.stacked && index < data.series.length - 1 ? 0 : [4, 4, 0, 0]}
              maxBarSize={56}
              isAnimationActive={false}
              {...(chart.stacked ? { stackId: "stack" } : {})}
            >
              {series === labelled ? lastLabel(series.key) : null}
            </Bar>
          ))}
        </BarChart>
      )}
    </ChartContainer>
  )
})
