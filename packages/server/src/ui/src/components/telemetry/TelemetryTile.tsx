import type { TelemetryProperty } from "@pario/client"
import { cn } from "../../lib/utils"
import { MiniSparkline } from "../common/MiniSparkline"
import { TelemetryValue } from "../TelemetryValue"
import { Badge } from "../ui/badge"

interface TelemetryTileProps {
  propertyId: string
  property: TelemetryProperty
  historyData?: { value: number; timestamp: string }[]
  isSelected?: boolean
  onSelect: () => void
  latestValue?: {
    value: number | string | boolean
    quality?: "good" | "bad" | "uncertain"
  }
}

const typeColors: Record<string, string> = {
  sensor: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  setpoint: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  command: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
}

const qualityDotColors = {
  good: "bg-emerald-500",
  bad: "bg-red-500",
  uncertain: "bg-amber-500",
}

function getTelemetryKind(property: TelemetryProperty): "sensor" | "setpoint" | "command" {
  const propertyClass = property.class?.toLowerCase() ?? ""
  if (propertyClass.includes("command")) return "command"
  if (propertyClass.includes("setpoint") || property.writable) return "setpoint"
  return "sensor"
}

export function TelemetryTile({
  propertyId,
  property,
  historyData,
  isSelected,
  onSelect,
  latestValue,
}: TelemetryTileProps) {
  const telemetryType = getTelemetryKind(property)
  const telemetryLabel = property.class ?? telemetryType
  const currentValue = latestValue?.value ?? property.currentValue
  const currentQuality = latestValue?.quality ?? property.quality
  const isNumeric = typeof currentValue === "number"
  const hasHistory = historyData && historyData.length > 1

  return (
    <button
      onClick={onSelect}
      className={cn(
        "relative flex flex-col p-3 rounded-xl text-left transition-all duration-200",
        "border bg-card/60 backdrop-blur-sm hover:bg-card/80",
        "hover:scale-[1.02] hover:shadow-lg",
        isSelected
          ? "border-emerald-500/50 ring-1 ring-emerald-500/30 bg-emerald-500/5"
          : "border-border/50 hover:border-border"
      )}
    >
      {/* Top row: Quality dot + Type badge */}
      <div className="flex items-center justify-between mb-2">
        <div
          className={cn(
            "w-2 h-2 rounded-full",
            currentQuality ? qualityDotColors[currentQuality] : "bg-muted-foreground/30"
          )}
          title={currentQuality || "unknown"}
        />
        <Badge
          variant="secondary"
          className={cn(
            "text-[9px] font-medium px-1.5 py-0 h-4 border",
            typeColors[telemetryType] || "bg-muted text-muted-foreground"
          )}
        >
          {telemetryLabel}
        </Badge>
      </div>

      {/* Sparkline (for numeric sensors with history) */}
      {isNumeric && hasHistory && (
        <div className="flex justify-center my-2">
          <MiniSparkline
            data={historyData}
            width={80}
            height={28}
            color={isSelected ? "#10b981" : "#64748b"}
            showDot
          />
        </div>
      )}

      {/* Placeholder for non-numeric or no history */}
      {(!isNumeric || !hasHistory) && (
        <div className="flex justify-center items-center my-2 h-7">
          {telemetryType === "command" ? (
            <svg
              className="w-5 h-5 text-emerald-500/60"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          ) : telemetryType === "setpoint" && property.writable ? (
            <svg
              className="w-5 h-5 text-amber-500/60"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          ) : (
            <div className="w-5 h-5" />
          )}
        </div>
      )}

      {/* Value */}
      <div className="mt-auto">
        <TelemetryValue
          value={currentValue}
          unit={property.unit}
          quality={currentQuality}
          size="md"
          className="block truncate"
        />
        <p className="text-xs text-muted-foreground truncate mt-0.5">{propertyId}</p>
      </div>

      {/* Writable indicator */}
      {property.writable && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        </div>
      )}
    </button>
  )
}
