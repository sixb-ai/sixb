import { cn } from "../lib/utils"

interface TelemetryValueProps {
  value: number | string | boolean | null | undefined
  unit?: string
  quality?: "good" | "bad" | "uncertain" | null
  size?: "sm" | "md" | "lg"
  className?: string
}

function formatValue(
  value: number | string | boolean | null | undefined,
  unit?: string
): { display: string; suffix: string } {
  if (value === null || value === undefined) return { display: "--", suffix: "" }

  if (typeof value === "boolean") {
    return { display: value ? "On" : "Off", suffix: "" }
  }

  if (typeof value === "number") {
    // Format bytes
    if (unit === "bytes") {
      const sizes = ["B", "KB", "MB", "GB", "TB"]
      if (value === 0) return { display: "0", suffix: "B" }
      const i = Math.floor(Math.log(value) / Math.log(1024))
      return {
        display: (value / 1024 ** i).toFixed(1),
        suffix: sizes[i],
      }
    }

    // Format bytes/s
    if (unit === "bytes/s") {
      const sizes = ["B/s", "KB/s", "MB/s", "GB/s"]
      if (value === 0) return { display: "0", suffix: "B/s" }
      const i = Math.floor(Math.log(Math.abs(value)) / Math.log(1024))
      return {
        display: (value / 1024 ** i).toFixed(1),
        suffix: sizes[i],
      }
    }

    // Format percent
    if (unit === "percent") {
      return { display: value.toFixed(1), suffix: "%" }
    }

    // Format celsius
    if (unit === "celsius") {
      return { display: value.toFixed(1), suffix: "°C" }
    }

    // Generic number
    return { display: value.toFixed(1), suffix: unit || "" }
  }

  return { display: String(value), suffix: "" }
}

export function TelemetryValue({
  value,
  unit,
  quality,
  size = "md",
  className,
}: TelemetryValueProps) {
  const { display, suffix } = formatValue(value, unit)

  const qualityColor =
    quality === "good"
      ? "text-emerald-400"
      : quality === "bad"
        ? "text-red-400"
        : quality === "uncertain"
          ? "text-amber-400"
          : "text-foreground"

  const sizeClasses = {
    sm: "text-sm font-semibold",
    md: "text-base font-semibold",
    lg: "text-2xl font-semibold tracking-tight",
  }

  return (
    <span className={cn("tabular-nums", qualityColor, sizeClasses[size], className)}>
      {display}
      {suffix && <span className="text-muted-foreground ml-1 text-sm font-normal">{suffix}</span>}
    </span>
  )
}
