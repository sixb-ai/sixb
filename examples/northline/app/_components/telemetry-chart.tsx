import { cn } from "@sixb/ui/lib/utils"
import { type PointerEvent, useEffect, useRef, useState } from "react"
import { formatDateTime, formatTime } from "./ui"

export interface TelemetryPoint {
  readonly value: number | null
  readonly at: string
}

const HEIGHT = 168
const PAD = { top: 12, right: 12, bottom: 26, left: 40 }

/**
 * A reading over time against its expected range. Drawn at the container's real width, so text
 * and strokes keep their size; hovering shows the reading and when it was taken.
 */
export function TelemetryChart({
  points,
  unit,
  expectedLow,
  expectedHigh,
  label,
}: {
  /** Newest first, as telemetry history returns them. */
  points: readonly TelemetryPoint[]
  unit: string
  expectedLow: number
  expectedHigh: number
  label: string
}) {
  const wrapper = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const element = wrapper.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry?.contentRect.width ?? 0))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const values = points
    .filter((point): point is { value: number; at: string } => typeof point.value === "number")
    .slice()
    .reverse()

  if (values.length < 2) {
    return (
      <div className="flex h-[168px] items-center justify-center rounded-[14px] bg-muted text-[13px] text-muted-foreground">
        The trend appears when building controls report history.
      </div>
    )
  }

  const plotWidth = Math.max(0, width - PAD.left - PAD.right)
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const all = values.map((point) => point.value)
  const span = Math.max(...all, expectedHigh) - Math.min(...all, expectedLow)
  const min = Math.floor(Math.min(...all, expectedLow) - span * 0.12)
  const max = Math.ceil(Math.max(...all, expectedHigh) + span * 0.12)
  const x = (index: number) => PAD.left + (index / (values.length - 1)) * plotWidth
  const y = (value: number) =>
    PAD.top + plotHeight - ((value - min) / (max - min || 1)) * plotHeight
  const path = values
    .map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point.value)}`)
    .join(" ")
  const latest = values.at(-1) ?? values[0]
  const outOfRange = latest ? latest.value > expectedHigh || latest.value < expectedLow : false
  const stroke = outOfRange ? "var(--destructive)" : "var(--chart-1)"
  const ticks = [min, (min + max) / 2, max]
  const active = hover === null ? null : values[hover]

  const onMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - bounds.left - PAD.left) / (plotWidth || 1)
    setHover(Math.min(values.length - 1, Math.max(0, Math.round(ratio * (values.length - 1)))))
  }

  return (
    <div ref={wrapper} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={`${label}: ${latest?.value.toFixed(1)} ${unit} now, expected ${expectedLow} to ${expectedHigh} ${unit}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="block touch-none select-none"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--chart-grid)"
              />
              <text
                x={PAD.left - 10}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {Number.isInteger(tick) ? tick : tick.toFixed(1)}
              </text>
            </g>
          ))}
          <rect
            x={PAD.left}
            y={y(expectedHigh)}
            width={plotWidth}
            height={Math.max(2, y(expectedLow) - y(expectedHigh))}
            fill="color-mix(in srgb, var(--chart-1) 9%, transparent)"
          />
          <path
            d={path}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {latest ? (
            <circle
              cx={x(values.length - 1)}
              cy={y(latest.value)}
              r={4.5}
              fill={stroke}
              stroke="var(--card)"
              strokeWidth={2}
            />
          ) : null}
          <text x={PAD.left} y={HEIGHT - 6} className="fill-muted-foreground text-[11px]">
            {formatTime(values[0]?.at)}
          </text>
          <text
            x={width - PAD.right}
            y={HEIGHT - 6}
            textAnchor="end"
            className="fill-muted-foreground text-[11px]"
          >
            {formatTime(latest?.at)}
          </text>
          {active && hover !== null ? (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={PAD.top}
                y2={PAD.top + plotHeight}
                stroke="var(--foreground)"
                strokeOpacity={0.25}
              />
              <circle
                cx={x(hover)}
                cy={y(active.value)}
                r={4}
                fill={stroke}
                stroke="var(--card)"
                strokeWidth={2}
              />
            </g>
          ) : null}
        </svg>
      ) : (
        <div className="h-[168px]" />
      )}
      {active && hover !== null ? (
        <div
          className={cn(
            "pointer-events-none absolute top-0 rounded-[10px] bg-popover px-3 py-2 text-[12.5px] shadow-[var(--shadow-raised)]",
            x(hover) > width / 2 ? "-translate-x-[calc(100%+12px)]" : "translate-x-3"
          )}
          style={{ left: x(hover) }}
        >
          <div className="font-semibold tabular-nums">
            {active.value.toFixed(1)} {unit}
          </div>
          <div className="text-muted-foreground">{formatDateTime(active.at)}</div>
        </div>
      ) : null}
    </div>
  )
}
