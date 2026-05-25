import type { ParioEventOfType } from "@pario/client"

export interface TelemetryUpdate {
  readonly type: "telemetryUpdate"
  readonly projectId: string
  readonly projectName: string
  readonly objectTypeId: string
  readonly objectId: string
  readonly propertyId: string
  readonly value: number | string | boolean
  readonly timestamp: string
  readonly quality: "good" | "uncertain" | "bad"
  readonly unit?: string
}

export function telemetryUpdateFromEvent(
  event: ParioEventOfType<"telemetry.appended">
): TelemetryUpdate {
  return {
    type: "telemetryUpdate",
    projectId: event.projectId,
    projectName: event.projectId,
    objectTypeId: event.payload.objectTypeId,
    objectId: event.payload.objectId,
    propertyId: event.payload.propertyId,
    value: normalizeTelemetryValue(event.payload.value),
    timestamp: event.payload.at,
    quality: "good",
    unit: event.payload.unit,
  }
}

function normalizeTelemetryValue(value: unknown): number | string | boolean {
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value
  }

  if (value === null) {
    return "null"
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
