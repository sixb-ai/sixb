import type { TelemetryProperty } from "@sixb/client"
import { Badge, Card, MiniSparkline } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { TelemetryValue } from "../TelemetryValue"

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
  sensor: "bg-muted text-muted-foreground border-border",
  setpoint: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
  command: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
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
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "relative cursor-pointer flex-col gap-0 p-3 text-left transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isSelected ? "border-foreground/40 ring-1 ring-foreground/10 bg-muted" : ""
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
    </Card>
  )
}
