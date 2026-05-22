import type { TelemetryProperty } from "@pario/client"
import { Badge } from "@pario/ui/components"
import { cn } from "@pario/ui/lib/utils"
import { useMemo } from "react"
import { TelemetryTile } from "./TelemetryTile"

interface TelemetryGridProps {
  telemetry: Record<string, TelemetryProperty>
  historyByProperty?: Record<string, { value: number; timestamp: string }[]>
  selectedPropertyId?: string | null
  onSelectProperty: (propertyId: string) => void
  latestUpdates?: Record<
    string,
    { value: number | string | boolean; quality?: "good" | "bad" | "uncertain" }
  >
  compact?: boolean
}

interface GroupedTelemetry {
  sensors: [string, TelemetryProperty][]
  setpoints: [string, TelemetryProperty][]
  commands: [string, TelemetryProperty][]
}

export function TelemetryGrid({
  telemetry,
  historyByProperty = {},
  selectedPropertyId,
  onSelectProperty,
  latestUpdates = {},
  compact = false,
}: TelemetryGridProps) {
  const grouped = useMemo(() => {
    const result: GroupedTelemetry = {
      sensors: [],
      setpoints: [],
      commands: [],
    }

    for (const [id, property] of Object.entries(telemetry)) {
      const propertyClass = property.class?.toLowerCase() ?? ""
      if (propertyClass.includes("command")) {
        result.commands.push([id, property])
      } else if (propertyClass.includes("setpoint") || property.writable) {
        result.setpoints.push([id, property])
      } else {
        result.sensors.push([id, property])
      }
    }

    return result
  }, [telemetry])

  const renderSection = (
    title: string,
    items: [string, TelemetryProperty][],
    colorClass: string
  ) => {
    if (items.length === 0) return null

    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {title}
          </h3>
          <Badge variant="secondary" className={cn("text-[10px] font-medium", colorClass)}>
            {items.length}
          </Badge>
        </div>
        <div
          className={cn(
            "grid gap-3",
            compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
          )}
        >
          {items.map(([propertyId, property]) => (
            <TelemetryTile
              key={propertyId}
              propertyId={propertyId}
              property={property}
              historyData={historyByProperty[propertyId]}
              isSelected={selectedPropertyId === propertyId}
              onSelect={() => onSelectProperty(propertyId)}
              latestValue={latestUpdates[propertyId]}
            />
          ))}
        </div>
      </div>
    )
  }

  const totalProperties = Object.keys(telemetry).length
  if (totalProperties === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <svg
          className="w-10 h-10 text-muted-foreground/30 mb-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
        <p className="text-sm text-muted-foreground">No telemetry defined</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {renderSection("Sensors", grouped.sensors, "bg-muted text-muted-foreground")}
      {renderSection(
        "Setpoints",
        grouped.setpoints,
        "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      )}
      {renderSection(
        "Commands",
        grouped.commands,
        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      )}
    </div>
  )
}
