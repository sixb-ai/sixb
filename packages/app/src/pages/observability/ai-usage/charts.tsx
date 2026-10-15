// Loaded only when AI usage opens, so the charting library stays out of every other page's bundle.
import type { ReactNode } from "react"
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts"

export interface TimeSeriesProps {
  readonly data: readonly Readonly<Record<string, number | string | undefined>>[]
  readonly xKey: string
  readonly series: readonly {
    readonly key: string
    readonly label: string
    readonly color: string
    readonly stackId?: string
  }[]
  /** The least height; in a flex column the chart grows past it to fill the space. */
  readonly height?: number
  readonly yAxisWidth?: number
  readonly showLegend?: boolean
  readonly xFormatter: (value: string) => string
  readonly tooltipLabel?: (value: string) => ReactNode
  readonly valueFormatter: (value: number) => string
  readonly emptyLabel: string
  readonly ariaLabel: string
}

/** Bars over time, one series or several stacked, in the theme's chart colors. */
export default function TimeSeries({
  data,
  xKey,
  series,
  height = 260,
  yAxisWidth = 54,
  showLegend = true,
  xFormatter,
  tooltipLabel,
  valueFormatter,
  emptyLabel,
  ariaLabel,
}: TimeSeriesProps) {
  if (data.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border text-[0.8125rem] text-muted-foreground"
        style={{ minHeight: height }}
      >
        {emptyLabel}
      </div>
    )
  }
  return (
    // Recharts makes the chart focusable for its keyboard support, and a click then draws the
    // browser's focus ring around the chart or its bars.
    <div
      role="img"
      aria-label={ariaLabel}
      className="w-full flex-1 [&_*:focus]:outline-none"
      style={{ minHeight: height }}
    >
      <BarChart
        responsive
        style={{ width: "100%", height: "100%" }}
        data={[...data]}
        margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
      >
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey={xKey}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tickMargin={10}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickFormatter={(value) => xFormatter(String(value))}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={yAxisWidth}
          tickMargin={8}
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          tickFormatter={(value) => valueFormatter(Number(value))}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          contentStyle={{
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            color: "var(--popover-foreground)",
            fontSize: 12,
          }}
          labelStyle={{ color: "var(--muted-foreground)", marginBottom: 4 }}
          wrapperStyle={{ zIndex: 20, outline: "none" }}
          labelFormatter={(label) =>
            typeof label === "string" ? (tooltipLabel ?? xFormatter)(label) : label
          }
          formatter={(value, name) => [
            valueFormatter(Number(value)),
            series.find((entry) => entry.key === String(name))?.label ?? String(name),
          ]}
        />
        {showLegend ? (
          <Legend
            iconSize={8}
            iconType="circle"
            height={28}
            wrapperStyle={{ color: "var(--muted-foreground)", fontSize: 12, paddingTop: 8 }}
            formatter={(value) =>
              series.find((entry) => entry.key === String(value))?.label ?? String(value)
            }
          />
        ) : null}
        {series.map((entry) => (
          <Bar
            key={entry.key}
            dataKey={entry.key}
            stackId={entry.stackId}
            fill={entry.color}
            radius={[3, 3, 0, 0]}
            maxBarSize={36}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </div>
  )
}
