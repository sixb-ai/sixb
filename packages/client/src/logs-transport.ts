import { isSixbErrorCode, type SixbErrorCode } from "@sixb/core/errors"
import {
  isStoredLogLine,
  type LogLevel,
  type LogRunRef,
  type SixbRunKind,
  type StoredLogLine,
} from "@sixb/core/logging"
import {
  createReconnectingSocket,
  createSixbWebSocketUrl,
  type ReconnectingSocketState,
  type SixbFailure,
} from "./ws-socket"

export type { SixbFailure } from "./ws-socket"

export type LogSocketState = ReconnectingSocketState

export interface LogSocketOptions {
  readonly kinds?: readonly SixbRunKind[]
  readonly levels?: readonly LogLevel[]
  readonly run?: LogRunRef
  readonly afterCursor?: string
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  /** API origin override. Authentication uses the browser session cookie. */
  readonly baseUrl?: string
  readonly onLog: (line: StoredLogLine) => void
  readonly onError?: (failure: SixbFailure) => void
  readonly onReset?: (cursor?: string) => void
  readonly onStateChange?: (state: LogSocketState) => void
}

export interface LogSocket {
  close(): void
}

type LogStreamServerMessage =
  | { readonly type: "connected" | "subscribed" | "unsubscribed" }
  | {
      readonly type: "error"
      /**
       * The failure's code. Branch on it rather than on `message`, which is prose and may be reworded.
       *
       * Falls back to `runtime.unexpected` for a frame that carries no code or one this build does not
       * know — a server older than this client, or newer.
       */
      readonly code: SixbErrorCode
      readonly message: string
    }
  | { readonly type: "logs"; readonly logs: readonly StoredLogLine[] }
  | { readonly type: "reset"; readonly reason: "cursor_expired"; readonly cursor?: string }

export function createLogSocket(options: LogSocketOptions): LogSocket {
  let latestCursor = options.afterCursor

  return createReconnectingSocket({
    url: createSixbLogsWebSocketUrl(options.baseUrl),
    reconnect: options.reconnect,
    reconnectDelayMs: options.reconnectDelayMs,
    connectionErrorMessage: "Log websocket connection failed.",
    onError: options.onError,
    onStateChange: options.onStateChange,
    subscribeMessage: () => ({
      type: "subscribe",
      ...(options.kinds?.length ? { kinds: options.kinds } : {}),
      ...(options.levels?.length ? { levels: options.levels } : {}),
      ...(options.run ? { run: options.run } : {}),
      ...(latestCursor ? { afterCursor: latestCursor } : {}),
    }),
    onMessage: (data, sink) => {
      const message = parseLogStreamMessage(data)
      if (!message) return

      if (message.type === "logs") {
        for (const line of message.logs) {
          latestCursor = line.cursor
          options.onLog(line)
        }
      } else if (message.type === "reset") {
        latestCursor = message.cursor
        options.onReset?.(message.cursor)
      } else if (message.type === "error") {
        sink.reportError({ code: message.code, message: message.message })
      }
    },
  })
}

export function createSixbLogsWebSocketUrl(baseUrl?: string): string {
  return createSixbWebSocketUrl("/ws/logs", baseUrl)
}

export function parseLogStreamMessage(value: unknown): LogStreamServerMessage | null {
  if (typeof value !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null

  if (parsed.type === "logs" && Array.isArray(parsed.logs) && parsed.logs.every(isStoredLogLine)) {
    return { type: "logs", logs: parsed.logs }
  }
  if (parsed.type === "reset" && parsed.reason === "cursor_expired") {
    return {
      type: "reset",
      reason: "cursor_expired",
      cursor: typeof parsed.cursor === "string" ? parsed.cursor : undefined,
    }
  }
  if (parsed.type === "error") {
    return {
      type: "error",
      code: isSixbErrorCode(parsed.code) ? parsed.code : "runtime.unexpected",
      message: String(parsed.message ?? "Log stream error."),
    }
  }
  if (["connected", "subscribed", "unsubscribed"].includes(parsed.type)) {
    return { type: parsed.type as "connected" | "subscribed" | "unsubscribed" }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
