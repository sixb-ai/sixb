import { useCallback, useEffect, useRef, useState } from "react"
import { client } from "./generated/client.gen"

export interface TelemetryUpdate {
  type: "telemetryUpdate"
  projectId: string
  projectName: string
  objectTypeId: string
  objectId: string
  propertyId: string
  value: number | string | boolean
  timestamp: string
  quality: "good" | "uncertain" | "bad"
  unit?: string
}

interface TelemetryPayload {
  objectTypeId: string
  objectId: string
  propertyId: string
  value: number | string | boolean
  unit?: string
  at: string
}

interface EventServerMessage {
  type: "event"
  event: {
    type:
      | "object.upserted"
      | "telemetry.appended"
      | "link.upserted"
      | "link.removed"
      | "action.requested"
      | "action.completed"
      | "action.failed"
    projectId: string
    payload: unknown
    occurredAt: string
  }
}

function normalizeValue(value: unknown): number | string | boolean {
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

function parseTelemetryEvent(message: EventServerMessage): TelemetryUpdate | null {
  if (message.event?.type !== "telemetry.appended") return null

  const payload = message.event.payload as TelemetryPayload | undefined
  if (!payload?.objectTypeId || !payload?.objectId || !payload?.propertyId) return null

  return {
    type: "telemetryUpdate",
    projectId: message.event.projectId,
    projectName: message.event.projectId,
    objectTypeId: payload.objectTypeId,
    objectId: payload.objectId,
    propertyId: payload.propertyId,
    value: normalizeValue(payload.value),
    timestamp: payload.at,
    quality: "good",
    unit: payload.unit,
  }
}

export function useWebSocket(onUpdate: (update: TelemetryUpdate) => void, projectName?: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const onUpdateRef = useRef(onUpdate)

  useEffect(() => {
    onUpdateRef.current = onUpdate
  }, [onUpdate])

  useEffect(() => {
    const fallbackBaseUrl =
      typeof window === "undefined" ? "http://localhost:3000" : window.location.origin
    const wsUrl = new URL(client.getConfig().baseUrl ?? fallbackBaseUrl)
    const protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
    const projectQuery = projectName ? `?project=${encodeURIComponent(projectName)}` : ""
    const ws = new WebSocket(`${protocol}//${wsUrl.host}/ws/events${projectQuery}`)

    ws.onopen = () => {
      setConnected(true)
    }

    ws.onclose = () => {
      setConnected(false)
    }

    ws.onerror = () => {
      setConnected(false)
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as EventServerMessage
        const update = parseTelemetryEvent(message)
        if (update && (!projectName || update.projectName === projectName)) {
          onUpdateRef.current(update)
        }
      } catch {
        // Ignore parse errors
      }
    }

    wsRef.current = ws

    return () => {
      ws.close()
    }
  }, [projectName])

  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message))
    }
  }, [])

  return { connected, send }
}
