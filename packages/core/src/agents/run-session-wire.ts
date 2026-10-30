import { ArtifactRequestError } from "../artifacts/errors"
import { createSixbError, isSixbError } from "../errors/internal"
import { ModelUsageRecordingError } from "../models/execution/errors"
import { AgentStorageError } from "../storage/agents/errors"
import { AgentToolPublicError, AgentToolResultValidationError } from "./errors"
import { AgentExecutionLostError, AgentRunRefusedError } from "./run-fence"
import { AgentFinalizationError } from "./run-session"

// How a run session crosses HTTP: one route per operation, under the run's path, each request a
// JSON body and each answer a JSON body. Records carry dates, model messages carry bytes and some
// answers are maps, so values are tagged JSON. Errors cross as their kind, so the runner throws
// the same classes it would in process.

/** Where a runner reaches its run's session. */
export function agentRunSessionPath(runId: string, operation: string): string {
  return `/api/agent-runs/${encodeURIComponent(runId)}/session/${operation}`
}

/** The run and operation a session request names, or null for a path that is not one. */
export function parseAgentRunSessionPath(
  pathname: string
): { readonly runId: string; readonly operation: string } | null {
  const match = /^\/api\/agent-runs\/([^/]+)\/session\/(.+)$/.exec(pathname)
  if (!match?.[1] || !match[2]) return null
  return { runId: decodeURIComponent(match[1]), operation: match[2] }
}

const TAG = "$sixb"

/** JSON that keeps dates, bytes and maps. */
export function encodeWireValue(value: unknown): string {
  return JSON.stringify(value, function (key, current: unknown) {
    // `toJSON` already turned a date into a string: read it from the holder.
    const raw: unknown = (this as Record<string, unknown>)[key]
    if (raw instanceof Date) return { [TAG]: "date", value: raw.toISOString() }
    if (raw instanceof Uint8Array) {
      return { [TAG]: "bytes", value: Buffer.from(raw).toString("base64") }
    }
    if (raw instanceof Map) return { [TAG]: "map", value: [...raw.entries()] }
    return current
  })
}

export function decodeWireValue(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (!isTagged(value)) return value
    if (value[TAG] === "date") return new Date(value.value as string)
    if (value[TAG] === "bytes") return new Uint8Array(Buffer.from(value.value as string, "base64"))
    return new Map(value.value as [unknown, unknown][])
  })
}

function isTagged(value: unknown): value is { readonly [TAG]: string; readonly value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    TAG in value &&
    ["date", "bytes", "map"].includes((value as Record<string, unknown>)[TAG] as string)
  )
}

/** An error as it crosses: its kind, and what rebuilding it needs. */
export interface WireError {
  readonly kind: string
  readonly message: string
  readonly code?: string
  readonly runId?: string
  readonly toolName?: string
  readonly reason?: string
  readonly executionId?: string
  readonly callId?: string
  readonly recoveryScheduled?: boolean
  readonly details?: unknown
  readonly latest?: unknown
}

export function encodeWireError(error: unknown): WireError {
  if (error instanceof AgentExecutionLostError) {
    return { kind: error.name, message: error.message, runId: error.runId }
  }
  if (error instanceof AgentFinalizationError) {
    return { kind: error.name, message: error.message, runId: error.runId }
  }
  if (error instanceof AgentToolResultValidationError) {
    return {
      kind: error.name,
      message: error.message,
      toolName: error.toolName,
      reason: error.reason,
    }
  }
  if (error instanceof AgentRunRefusedError) return { kind: error.name, message: error.message }
  if (error instanceof AgentToolPublicError)
    return { kind: "AgentToolPublicError", message: error.message }
  if (error instanceof ModelUsageRecordingError) {
    return {
      kind: error.name,
      message: error.message,
      executionId: error.executionId,
      callId: error.callId,
      recoveryScheduled: error.recoveryScheduled,
    }
  }
  if (error instanceof ArtifactRequestError) {
    return {
      kind: error.name,
      message: error.message,
      code: error.code,
      ...(error.latest === undefined ? {} : { latest: error.latest }),
    }
  }
  if (error instanceof AgentStorageError) {
    return { kind: error.name, message: error.message, code: error.code }
  }
  if (isSixbError(error)) {
    return {
      kind: "SixbError",
      message: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return { kind: "AbortError", message: error.message }
  }
  // Anything else stays on the server: the runner learns only that the operation failed.
  console.error("[Sixb] A run session operation failed.", error)
  return { kind: "Error", message: "[Sixb] The run session operation failed on the server." }
}

/** The HTTP status an error answers with. */
export function wireErrorStatus(error: WireError): number {
  if (error.kind === "AgentExecutionLostError") return 409
  if (error.kind === "AbortError") return 499
  if (error.kind === "Error" || error.kind === "AgentFinalizationError") return 500
  return 400
}

export function decodeWireError(error: WireError): Error {
  switch (error.kind) {
    case "AgentExecutionLostError":
      return new AgentExecutionLostError(error.runId ?? "")
    case "AgentFinalizationError":
      return new AgentFinalizationError(error.runId ?? "")
    case "AgentToolResultValidationError":
      return new AgentToolResultValidationError(error.toolName ?? "", error.reason ?? "")
    case "AgentRunRefusedError":
      return new AgentRunRefusedError(error.message)
    case "AgentToolPublicError":
    case "AgentToolOutputError":
      return new AgentToolPublicError(error.message)
    case "ModelUsageRecordingError":
      return new ModelUsageRecordingError(
        error.executionId ?? "",
        error.callId ?? "",
        error.recoveryScheduled ?? false
      )
    case "ArtifactRequestError":
      return new ArtifactRequestError(
        error.code as ConstructorParameters<typeof ArtifactRequestError>[0],
        error.message,
        error.latest as ConstructorParameters<typeof ArtifactRequestError>[2]
      )
    case "AgentStorageError":
      return new AgentStorageError(
        error.code as ConstructorParameters<typeof AgentStorageError>[0],
        error.message
      )
    case "SixbError":
      return createSixbError(
        error.code as Parameters<typeof createSixbError>[0],
        error.message,
        error.details === undefined
          ? {}
          : {
              details: error.details as NonNullable<
                Parameters<typeof createSixbError>[2]
              >["details"],
            }
      )
    case "AbortError":
      return new DOMException(error.message, "AbortError")
    default:
      return new Error(error.message)
  }
}
