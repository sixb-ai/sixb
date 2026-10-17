import type { WorkbookChart } from "@sixb/core/artifacts"
import { useLocale } from "@sixb/ui/lib/i18n"
import { useMemo } from "react"
import { chartData } from "./chart-data"
import type { SheetModel } from "./model"

// A chart at a glance, as a card previews it: the shape of the data in the theme's chart colors,
// with no axes to read. Drawn as plain SVG, so a card never loads the charting library.
const WIDTH = 200
const HEIGHT = 64

export function MiniChart({
  chart,
  model,
}: {
  readonly chart: WorkbookChart
  readonly model: SheetModel
}) {
  const data = useMemo(() => chartData(chart, model), [chart, model])
  if (!data) return null
  const series = data.series.map((entry) => ({
    color: entry.color,
    values: data.rows.map((row) => {
      const value = row[entry.key]
      return typeof value === "number" ? value : null
    }),
  }))
  if (chart.type === "pie") {
    const [first] = series
    return first ? (
      <MiniPie labels={data.rows.map((row) => String(row.x ?? ""))} values={first.values} />
    ) : null
  }
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="block size-full overflow-visible"
      aria-hidden="true"
    >
      {chart.type === "bar" ? (
        <Bars series={series} stacked={chart.stacked} />
      ) : (
        <Lines series={series} area={chart.type === "area"} stacked={chart.stacked} />
      )}
    </svg>
  )
}

interface Series {
  readonly color: string
  readonly values: readonly (number | null)[]
}

function Bars({
  series,
  stacked,
}: {
  readonly series: readonly Series[]
  readonly stacked: boolean
}) {
  const count = series[0]?.values.length ?? 0
  if (count === 0) return null
  const totals = Array.from({ length: count }, (_, index) =>
    stacked
      ? series.reduce((sum, entry) => sum + Math.max(0, entry.values[index] ?? 0), 0)
      : Math.max(0, ...series.map((entry) => entry.values[index] ?? 0))
  )
  const max = Math.max(...totals) || 1
  const slot = WIDTH / count
  const group = slot * 0.64
  const width = stacked ? group : group / series.length
  const y = (value: number) => HEIGHT * (1 - value / max)
  return (
    <>
      {Array.from({ length: count }, (_, index) => {
        let base = 0
        return series.map((entry, position) => {
          const value = Math.max(0, entry.values[index] ?? 0)
          const x = index * slot + (slot - group) / 2 + (stacked ? 0 : position * width)
          const top = stacked ? base + value : value
          const rect = (
            <rect
              key={`${index}:${position}`}
              x={x + (stacked ? 0 : 0.6)}
              y={y(top)}
              width={Math.max(0.5, width - (stacked ? 0 : 1.2))}
              height={Math.max(0, y(stacked ? base : 0) - y(top))}
              rx={1}
              fill={entry.color}
            />
          )
          base = top
          return rect
        })
      })}
    </>
  )
}

function Lines({
  series,
  area,
  stacked,
}: {
  readonly series: readonly Series[]
  readonly area: boolean
  readonly stacked: boolean
}) {
  const count = series[0]?.values.length ?? 0
  if (count === 0) return null
  // Stacked areas sit on the series before them.
  const layers = series.map((entry, position) =>
    entry.values.map((value, index) =>
      value === null
        ? null
        : stacked
          ? series
              .slice(0, position + 1)
              .reduce((sum, layer) => sum + Math.max(0, layer.values[index] ?? 0), 0)
          : value
    )
  )
  const all = layers.flat().filter((value): value is number => value !== null)
  if (all.length === 0) return null
  // An area measures from zero; a line shows change, so it fits its values.
  const low = area ? Math.min(0, ...all) : Math.min(...all)
  const high = Math.max(...all)
  const pad = area ? 0 : (high - low) * 0.12 || 1
  const min = low - pad
  const max = high + pad
  const x = (index: number) => (count === 1 ? WIDTH / 2 : (index / (count - 1)) * WIDTH)
  const y = (value: number) => HEIGHT * (1 - (value - min) / (max - min || 1))
  return (
    <>
      {layers.map((values, position) => {
        const color = series[position]?.color ?? "currentColor"
        // An empty cell is a gap in the line, not a zero.
        const runs: { index: number; value: number }[][] = [[]]
        values.forEach((value, index) => {
          if (value === null) runs.push([])
          else runs.at(-1)?.push({ index, value })
        })
        return runs
          .filter((run) => run.length > 0)
          .map((run, runIndex) => {
            const points = run.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")
            const first = run[0]
            const last = run.at(-1)
            return (
              <g key={`${position}:${runIndex}`}>
                {area && first && last ? (
                  <polygon
                    points={`${x(first.index)},${y(Math.max(min, 0))} ${points} ${x(last.index)},${y(Math.max(min, 0))}`}
                    fill={color}
                    fillOpacity={0.14}
                  />
                ) : null}
                <polyline
                  points={points}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            )
          })
      })}
    </>
  )
}

/** A donut of the slices, beside the largest of them with their shares. */
function MiniPie({
  labels,
  values,
}: {
  readonly labels: readonly string[]
  readonly values: readonly (number | null)[]
}) {
  const locale = useLocale()
  const slices = values
    .map((value, index) => ({
      label: labels[index] ?? "",
      value: Math.max(0, value ?? 0),
      color: `var(--chart-${(index % 5) + 1})`,
    }))
    .filter((slice) => slice.value > 0)
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  if (total === 0) return null
  const share = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 })
  const radius = 24
  const circumference = 2 * Math.PI * radius
  let offset = 0
  return (
    <span className="flex h-full items-center gap-4">
      <svg viewBox="0 0 64 64" className="h-full max-h-16 shrink-0" aria-hidden="true">
        <g transform="rotate(-90 32 32)">
          {slices.map((slice) => {
            const length = (slice.value / total) * circumference
            const circle = (
              <circle
                key={slice.label}
                cx={32}
                cy={32}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={11}
                strokeDasharray={`${Math.max(0, length - 1.2)} ${circumference}`}
                strokeDashoffset={-offset}
              />
            )
            offset += length
            return circle
          })}
        </g>
      </svg>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-[11px] leading-4">
        {[...slices]
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map((slice) => (
            <span key={slice.label} className="flex min-w-0 items-center gap-1.5">
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: slice.color }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{slice.label}</span>
              <span className="text-foreground tabular-nums">
                {share.format(slice.value / total)}
              </span>
            </span>
          ))}
      </span>
    </span>
  )
}
