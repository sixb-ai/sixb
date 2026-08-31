import { Card, CardContent, CardHeader, CardTitle, MiniSparkline } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import type { ReactNode } from "react"
import { useId } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts/lib/index.js"

const DEFAULT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const

interface AiUsageMetricCardProps {
  readonly label: string
  readonly value: ReactNode
  readonly description?: ReactNode
  readonly icon?: ReactNode
  readonly sparkline?: readonly { readonly value: number; readonly timestamp: string }[]
  readonly className?: string
}

export function AiUsageMetricCard({
  label,
  value,
  description,
  icon,
  sparkline,
  className,
}: AiUsageMetricCardProps) {
  return (
    <Card className={cn("min-w-0 gap-3 py-4", className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-4">
        <CardTitle className="truncate text-xs font-medium text-muted-foreground">
          {label}
        </CardTitle>
        {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
      </CardHeader>
      <CardContent className="px-4">
        <div className="flex min-w-0 items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-2xl font-semibold tracking-tight tabular-nums">
              {value}
            </div>
            {description ? (
              <p className="mt-1 truncate text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {sparkline && sparkline.length > 1 ? (
            <MiniSparkline data={[...sparkline]} width={72} height={30} className="shrink-0" />
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

interface AiUsageBreakdownDatum {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly color?: string
}

interface AiUsageBreakdownProps {
  readonly data: readonly AiUsageBreakdownDatum[]
  readonly valueLabel: string
  readonly height?: number
  readonly className?: string
  readonly valueFormatter?: (value: number) => string
  readonly emptyLabel?: string
  readonly ariaLabel: string
}

export function AiUsageBreakdown({
  data,
  valueLabel,
  height,
  className,
  valueFormatter,
  emptyLabel = "No data available",
  ariaLabel,
}: AiUsageBreakdownProps) {
  if (data.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-32 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground",
          className
        )}
        style={height === undefined ? undefined : { minHeight: height }}
      >
        {emptyLabel}
      </div>
    )
  }

  const maximum = Math.max(...data.map((item) => item.value), 0)

  return (
    <div
      className={cn("space-y-4", className)}
      style={height === undefined ? undefined : { minHeight: height }}
      role="img"
      aria-label={ariaLabel}
    >
      {data.map((item) => {
        const formattedValue = valueFormatter
          ? valueFormatter(item.value)
          : item.value.toLocaleString()
        const percentage = maximum === 0 ? 0 : (item.value / maximum) * 100

        return (
          <div key={item.key} aria-label={`${item.label}: ${formattedValue}`}>
            <div className="mb-1.5 flex items-start justify-between gap-4 text-sm">
              <span className="min-w-0 break-words text-muted-foreground" title={item.label}>
                {item.label}
              </span>
              <span className="shrink-0 font-mono font-medium tabular-nums" title={valueLabel}>
                {formattedValue}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  backgroundColor: item.color ?? "var(--chart-2)",
                  width: item.value > 0 ? `${Math.max(percentage, 0.75)}%` : 0,
                }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface AiUsageTimeSeriesDatum {
  readonly [key: string]: number | string | null | undefined
}

interface AiUsageTimeSeriesSeries {
  readonly key: string
  readonly label: string
  readonly color?: string
  readonly stackId?: string
}

interface AiUsageTimeSeriesProps {
  readonly data: readonly AiUsageTimeSeriesDatum[]
  readonly xKey: string
  readonly series: readonly AiUsageTimeSeriesSeries[]
  readonly variant?: "line" | "area" | "bar"
  readonly height?: number
  readonly yAxisWidth?: number
  readonly showLegend?: boolean
  readonly className?: string
  readonly xFormatter?: (value: string) => string
  readonly valueFormatter?: (value: number, seriesKey: string) => string
  readonly emptyLabel?: string
  readonly ariaLabel: string
}

export function AiUsageTimeSeries({
  data,
  xKey,
  series,
  variant = "line",
  height = 280,
  yAxisWidth = 54,
  showLegend = true,
  className,
  xFormatter,
  valueFormatter,
  emptyLabel = "No data available",
  ariaLabel,
}: AiUsageTimeSeriesProps) {
  const id = useId().replace(/:/g, "")
  if (data.length === 0 || series.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground",
          className
        )}
        style={{ height }}
      >
        {emptyLabel}
      </div>
    )
  }

  const configuredSeries = series.map((item, index) => ({
    ...item,
    color: item.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]!,
  }))
  const isolatedSeries = new Set(
    configuredSeries
      .filter((item) => data.filter((datum) => datum[item.key] != null).length === 1)
      .map((item) => item.key)
  )
  // Recharts 2 only discovers chart controls among direct children. Keep these as a flattened
  // array rather than a Fragment so axes, tooltips, and legends are registered by every variant.
  const common = [
    <CartesianGrid key="grid" vertical={false} stroke="var(--border)" strokeDasharray="3 3" />,
    <XAxis
      key="x-axis"
      dataKey={xKey}
      tickLine={false}
      axisLine={false}
      minTickGap={28}
      tickMargin={10}
      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
      tickFormatter={(value) => (xFormatter ? xFormatter(String(value)) : String(value))}
    />,
    <YAxis
      key="y-axis"
      tickLine={false}
      axisLine={false}
      width={yAxisWidth}
      tickMargin={8}
      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
      tickFormatter={(value) =>
        valueFormatter ? valueFormatter(Number(value), series[0]?.key ?? "value") : String(value)
      }
    />,
    <Tooltip
      key="tooltip"
      cursor={
        variant === "bar" ? { fill: "var(--muted)", opacity: 0.35 } : { stroke: "var(--border)" }
      }
      contentStyle={{
        background: "var(--popover)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        color: "var(--popover-foreground)",
        boxShadow: "0 6px 16px -4px rgb(0 0 0 / 0.3)",
        fontSize: 12,
      }}
      labelStyle={{ color: "var(--muted-foreground)", marginBottom: 4 }}
      wrapperStyle={{ zIndex: 20, outline: "none" }}
      labelFormatter={(label) =>
        xFormatter && typeof label === "string" ? xFormatter(label) : label
      }
      formatter={(value, name) => {
        const key = String(name)
        const seriesItem = configuredSeries.find((item) => item.key === key)
        const formattedValue = valueFormatter
          ? valueFormatter(Number(value), key)
          : Number(value).toLocaleString()
        return [formattedValue, seriesItem?.label ?? key]
      }}
    />,
    showLegend ? (
      <Legend
        key="legend"
        iconSize={8}
        iconType="circle"
        height={28}
        wrapperStyle={{ color: "var(--muted-foreground)", fontSize: 12, paddingTop: 8 }}
        formatter={(value) =>
          configuredSeries.find((item) => item.key === String(value))?.label ?? String(value)
        }
      />
    ) : null,
  ]

  return (
    <div className={cn("w-full", className)} style={{ height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === "area" ? (
          <AreaChart data={[...data]} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <defs>
              {configuredSeries.map((item) => (
                <linearGradient key={item.key} id={`${id}-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={item.color} stopOpacity={0.45} />
                  <stop offset="95%" stopColor={item.color} stopOpacity={0.04} />
                </linearGradient>
              ))}
            </defs>
            {common}
            {configuredSeries.map((item) => (
              <Area
                key={item.key}
                type="monotone"
                dataKey={item.key}
                stackId={item.stackId}
                stroke={item.color}
                fill={`url(#${id}-${item.key})`}
                strokeWidth={2}
                dot={isolatedSeries.has(item.key) ? { r: 3 } : false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        ) : variant === "bar" ? (
          <BarChart data={[...data]} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            {common}
            {configuredSeries.map((item) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                stackId={item.stackId}
                fill={item.color}
                radius={[3, 3, 0, 0]}
                maxBarSize={36}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        ) : (
          <LineChart data={[...data]} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            {common}
            {configuredSeries.map((item) => (
              <Line
                key={item.key}
                type="monotone"
                dataKey={item.key}
                stroke={item.color}
                strokeWidth={2}
                dot={isolatedSeries.has(item.key) ? { r: 3 } : false}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
