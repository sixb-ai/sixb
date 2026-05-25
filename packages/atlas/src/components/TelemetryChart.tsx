import type { TelemetryHistory } from "@pario/client"
import { getTelemetryHistoryOptions } from "@pario/client/hooks"
import { Button, Card } from "@pario/ui/components"
import { useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts/lib/index.js"
import type { TelemetryUpdate } from "../lib/telemetryEvents"
import { TelemetryValue } from "./TelemetryValue"

interface TelemetryChartProps {
  objectId: string
  propertyId: string
  projectName: string
  unit?: string
  latestUpdate?: TelemetryUpdate | null
  onClose: () => void
}

interface ChartPoint {
  timestamp: string
  value: number
}

function formatYAxis(value: number, unit?: string): string {
  if (unit === "bytes" || unit === "bytes/s") {
    const sizes = unit === "bytes" ? ["B", "KB", "MB", "GB", "TB"] : ["B/s", "KB/s", "MB/s", "GB/s"]
    if (value === 0) return "0"
    const i = Math.floor(Math.log(Math.abs(value)) / Math.log(1024))
    return `${(value / 1024 ** i).toFixed(0)}${sizes[Math.min(i, sizes.length - 1)]}`
  }
  if (unit === "percent") {
    return `${value.toFixed(0)}%`
  }
  return value.toFixed(1)
}

function formatTooltip(value: number, unit?: string): string {
  if (unit === "bytes") {
    const sizes = ["B", "KB", "MB", "GB", "TB"]
    if (value === 0) return "0 B"
    const i = Math.floor(Math.log(Math.abs(value)) / Math.log(1024))
    return `${(value / 1024 ** i).toFixed(2)} ${sizes[Math.min(i, sizes.length - 1)]}`
  }
  if (unit === "bytes/s") {
    const sizes = ["B/s", "KB/s", "MB/s", "GB/s"]
    if (value === 0) return "0 B/s"
    const i = Math.floor(Math.log(Math.abs(value)) / Math.log(1024))
    return `${(value / 1024 ** i).toFixed(2)} ${sizes[Math.min(i, sizes.length - 1)]}`
  }
  if (unit === "percent") {
    return `${value.toFixed(2)}%`
  }
  return value.toFixed(2)
}

function getTimestampMs(timestamp: string): number {
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : 0
}

function sortAndDedupeChartData(data: Array<{ timestamp: string; value: unknown }>): ChartPoint[] {
  const deduped = new Map<number, ChartPoint>()

  for (const sample of data) {
    const timestampMs = getTimestampMs(sample.timestamp)
    deduped.set(timestampMs, {
      timestamp: sample.timestamp,
      value: typeof sample.value === "number" ? sample.value : 0,
    })
  }

  return Array.from(deduped.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([, point]) => point)
}

function createChartTicks(points: ChartPoint[]): string[] {
  if (points.length <= 1) return points.map((point) => point.timestamp)

  const targetTickCount = points.length > 25 ? 4 : 3
  const step = Math.max(1, Math.floor((points.length - 1) / (targetTickCount - 1)))
  const ticks: string[] = []

  for (let index = 0; index < points.length; index += step) {
    ticks.push(points[index].timestamp)
  }

  const lastTimestamp = points[points.length - 1]?.timestamp
  if (lastTimestamp && ticks[ticks.length - 1] !== lastTimestamp) {
    ticks.push(lastTimestamp)
  }

  return Array.from(new Set(ticks))
}

const rangeWindowMs = 5 * 60 * 1000

export function TelemetryChart({
  objectId,
  propertyId,
  projectName,
  unit,
  latestUpdate,
  onClose,
}: TelemetryChartProps) {
  const {
    data: history,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    ...getTelemetryHistoryOptions({
      path: { projectName, objectId, propertyId },
      query: { range: "5m" },
    }),
  })
  const error = queryError ? String(queryError) : null
  const [liveHistory, setLiveHistory] = useState<TelemetryHistory | null>(
    history as TelemetryHistory | null
  )

  useEffect(() => {
    if (!history) {
      setLiveHistory(null)
      return
    }

    const historyData = history as TelemetryHistory
    setLiveHistory((prev: TelemetryHistory | null) => {
      if (!prev) return historyData
      if (prev.objectId !== historyData.objectId || prev.propertyId !== historyData.propertyId)
        return historyData

      const historyEnd = new Date(historyData.range.end).getTime()
      const appended = prev.data.filter(
        (sample: { timestamp: string }) => new Date(sample.timestamp).getTime() > historyEnd
      )

      if (appended.length === 0) return historyData

      const cutoff = Date.now() - rangeWindowMs
      const mergedData = [...historyData.data, ...appended].filter(
        (sample: { timestamp: string }) => new Date(sample.timestamp).getTime() >= cutoff
      )

      return {
        ...historyData,
        range: {
          start: new Date(cutoff).toISOString(),
          end: appended[appended.length - 1]?.timestamp ?? historyData.range.end,
        },
        data: mergedData,
      }
    })
  }, [history])

  useEffect(() => {
    if (!latestUpdate) return
    if (latestUpdate.projectName !== projectName) return
    if (latestUpdate.objectId !== objectId || latestUpdate.propertyId !== propertyId) return

    setLiveHistory((prev: TelemetryHistory | null) => {
      const cutoff = Date.now() - rangeWindowMs

      const nextSample = {
        value: latestUpdate.value,
        timestamp: latestUpdate.timestamp,
        quality: latestUpdate.quality,
      }

      if (!prev) {
        return {
          objectId,
          propertyId,
          range: {
            start: new Date(cutoff).toISOString(),
            end: latestUpdate.timestamp,
          },
          data: [nextSample],
        }
      }

      const last = prev.data[prev.data.length - 1]
      const shouldReplaceLast = last?.timestamp === nextSample.timestamp

      const nextData = shouldReplaceLast
        ? [...prev.data.slice(0, -1), nextSample]
        : [...prev.data, nextSample]

      const trimmedData = nextData.filter(
        (sample: { timestamp: string }) => new Date(sample.timestamp).getTime() >= cutoff
      )

      return {
        ...prev,
        range: {
          start: new Date(cutoff).toISOString(),
          end: latestUpdate.timestamp,
        },
        data: trimmedData,
      }
    })
  }, [objectId, propertyId, latestUpdate, projectName])

  const chartData = useMemo(() => {
    return sortAndDedupeChartData(
      liveHistory?.data.map((sample: { timestamp: string; value: unknown }) => ({
        timestamp: sample.timestamp,
        value: sample.value,
      })) ?? []
    )
  }, [liveHistory])

  const xTicks = useMemo(() => createChartTicks(chartData), [chartData])
  const lastPoint = chartData[chartData.length - 1] ?? null
  const latestValue = liveHistory?.data[liveHistory.data.length - 1]

  return (
    <Card className="overflow-hidden p-0 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2 motion-safe:duration-500">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h3 className="break-all text-[14px] font-semibold tracking-tight text-foreground sm:text-[15px] sm:break-normal">
            {objectId} / {propertyId}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Last 5 minutes</p>
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end sm:gap-6">
          {latestValue && (
            <div className="text-left sm:text-right">
              <p className="mb-1 text-[11px] text-muted-foreground">Current</p>
              <TelemetryValue
                value={latestValue.value as number | string | boolean | null}
                unit={unit}
                quality={latestValue.quality as "good" | "bad" | "uncertain" | null | undefined}
                size="lg"
              />
            </div>
          )}
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close chart">
            <X />
          </Button>
        </div>
      </div>

      <div className="p-4 sm:p-6">
        {loading && (
          <div className="flex h-44 items-center justify-center text-muted-foreground sm:h-52">
            <svg className="mr-2 h-6 w-6 animate-spin" viewBox="0 0 24 24">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            Loading...
          </div>
        )}

        {error && (
          <div className="flex h-44 items-center justify-center text-red-400 sm:h-52">
            Error: {error}
          </div>
        )}

        {!loading && !error && chartData.length === 0 && (
          <div className="flex h-44 items-center justify-center text-muted-foreground sm:h-52">
            No data available
          </div>
        )}

        {!loading && !error && chartData.length > 0 && (
          <div className="h-44 w-full sm:h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 12, bottom: 6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  ticks={xTicks}
                  tickFormatter={(value: string) =>
                    new Date(value).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })
                  }
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--border)" }}
                  dy={10}
                  interval={0}
                  minTickGap={30}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={(value) => formatYAxis(Number(value), unit)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    fontSize: "12px",
                    boxShadow: "0 6px 16px -4px rgb(0 0 0 / 0.3)",
                    color: "var(--foreground)",
                  }}
                  formatter={(value: number) => [formatTooltip(value, unit), propertyId]}
                  labelFormatter={(label) =>
                    new Date(label).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })
                  }
                  labelStyle={{ color: "var(--muted-foreground)", marginBottom: "4px" }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#10b981"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: "#10b981", stroke: "var(--background)", strokeWidth: 2 }}
                />
                {lastPoint && (
                  <ReferenceDot
                    x={lastPoint.timestamp}
                    y={lastPoint.value}
                    r={4}
                    fill="#10b981"
                    stroke="var(--background)"
                    strokeWidth={2}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  )
}
