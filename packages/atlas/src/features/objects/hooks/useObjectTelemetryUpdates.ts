import type { TelemetryUpdate } from "@sixb/client"
import { decodeObjectId, telemetryUpdateKey } from "@sixb/client"
import { events, useLatestByObject } from "@sixb/client/hooks"
import { useMemo } from "react"

export function useProjectTelemetryUpdates(
  projectName: string,
  options: { enabled?: boolean } = {}
): readonly TelemetryUpdate[] {
  const { byObject } = useLatestByObject(events.telemetry(), {
    enabled: Boolean(projectName) && (options.enabled ?? true),
  })

  return useMemo(
    () =>
      Object.values(byObject)
        .flatMap((updatesByProperty) => Object.values(updatesByProperty))
        .filter((update) => update.projectName === projectName),
    [byObject, projectName]
  )
}

export function useObjectTelemetryUpdates(
  projectName: string,
  objectId: string | undefined,
  options: { enabled?: boolean } = {}
): Record<string, TelemetryUpdate> {
  const parsed = objectId ? decodeObjectId(objectId) : null
  const builder = parsed ? events.telemetry().byId(parsed.primaryId) : events.telemetry()
  const { byObject } = useLatestByObject(builder, {
    enabled: Boolean(projectName && parsed) && (options.enabled ?? true),
  })

  return useMemo(() => {
    const flattened: Record<string, TelemetryUpdate> = {}
    for (const updatesByProperty of Object.values(byObject)) {
      for (const update of Object.values(updatesByProperty)) {
        if (update.projectName !== projectName) continue
        flattened[telemetryUpdateKey(update.projectName, update.objectId, update.propertyId)] =
          update
      }
    }
    return flattened
  }, [byObject, projectName])
}
