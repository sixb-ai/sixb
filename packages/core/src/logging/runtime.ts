import type { Broker, BrokerRetention, BrokerStreamDefinition } from "../broker"
import { getInvalidJsonValueReason, type JsonValue } from "../json"
import { ConsoleLogger, noopLoggerProvider } from "./console-logger"
import { createRunLogSession, type LogPublisher, type RunLogSession } from "./run-logger"
import {
  DEFAULT_LOG_BATCH_MAX_BYTES,
  DEFAULT_LOG_BATCH_MAX_DELAY_MS,
  DEFAULT_LOG_BATCH_MAX_RECORDS,
  DEFAULT_LOG_MAX_BUFFERED_BYTES,
  DEFAULT_LOGS_RETENTION,
  DEFAULT_MAX_LINES_PER_EXECUTION,
  DEFAULT_MAX_LOG_RECORD_BYTES,
  LOGS_STREAM,
} from "./stream"
import type { LoggerProvider, LogLevel, LogRunRef } from "./types"

export interface LogsObservabilityOptions {
  /** Forward handler logs to the broker. Defaults to `true`. */
  readonly enabled?: boolean
  /** Minimum level captured by the broker. Defaults to `"info"`. */
  readonly level?: LogLevel
  /** Retention overrides merged with the bounded defaults. */
  readonly retention?: BrokerRetention
  readonly limits?: {
    /** Captured lines per worker execution. Defaults to 10,000. */
    readonly maxLinesPerExecution?: number
    /** Maximum serialized UTF-8 bytes for one broker payload. Defaults to 64 KiB. */
    readonly maxRecordBytes?: number
    /** Maximum pending bytes while an append is in flight. Defaults to 1 MiB. */
    readonly maxBufferedBytes?: number
  }
  readonly batching?: {
    /** Flush immediately after this many records. Defaults to 64. */
    readonly maxRecords?: number
    /** Flush immediately after this many serialized bytes. Defaults to 256 KiB. */
    readonly maxBytes?: number
    /** Flush a partial batch after this delay. Defaults to 10 ms. */
    readonly maxDelayMs?: number
  }
  readonly redact?: {
    /** Dot paths relative to `fields` (an optional `fields.` prefix is accepted). */
    readonly paths: readonly string[]
    /** Replacement value. Defaults to `"[REDACTED]"`. */
    readonly censor?: JsonValue
  }
}

export interface ObservabilityOptions {
  readonly logs?: LogsObservabilityOptions
}

export interface LogsRuntimeOptions {
  readonly projectId: string
  /** Broker backing the `__logs` stream. Absent means output-only logging. */
  readonly broker?: Broker
  /** Process-level output provider. Defaults to {@link ConsoleLogger}. */
  readonly logger?: LoggerProvider
  readonly observability?: LogsObservabilityOptions
  /** Internal/testing stream override. */
  readonly stream?: BrokerStreamDefinition
}

/** Project-scoped logger factory and broker capture runtime. */
export class LogsRuntime {
  private readonly projectId: string
  private readonly broker?: Broker
  private readonly provider: LoggerProvider
  private readonly captureEnabled: boolean
  private readonly captureLevel: LogLevel
  private readonly maxLinesPerExecution: number
  private readonly maxRecordBytes: number
  private readonly maxBufferedBytes: number
  private readonly batchMaxRecords: number
  private readonly batchMaxBytes: number
  private readonly batchMaxDelayMs: number
  private readonly redactPaths: readonly string[]
  private readonly redactCensor: JsonValue
  private readonly stream: BrokerStreamDefinition
  private ensureStreamPromise?: Promise<void>

  constructor(options: LogsRuntimeOptions) {
    const config = options.observability ?? {}
    this.projectId = options.projectId
    this.broker = options.broker
    this.provider = options.logger ?? new ConsoleLogger()
    this.captureEnabled = config.enabled ?? true
    this.captureLevel = logLevel(config.level ?? "info", "observability.logs.level")
    this.maxLinesPerExecution = nonNegativeInteger(
      config.limits?.maxLinesPerExecution ?? DEFAULT_MAX_LINES_PER_EXECUTION,
      "observability.logs.limits.maxLinesPerExecution"
    )
    this.maxRecordBytes = positiveInteger(
      config.limits?.maxRecordBytes ?? DEFAULT_MAX_LOG_RECORD_BYTES,
      "observability.logs.limits.maxRecordBytes"
    )
    if (this.maxRecordBytes < 256) {
      throw new TypeError("observability.logs.limits.maxRecordBytes must be at least 256 bytes")
    }
    this.maxBufferedBytes = positiveInteger(
      config.limits?.maxBufferedBytes ?? DEFAULT_LOG_MAX_BUFFERED_BYTES,
      "observability.logs.limits.maxBufferedBytes"
    )
    this.batchMaxRecords = positiveInteger(
      config.batching?.maxRecords ?? DEFAULT_LOG_BATCH_MAX_RECORDS,
      "observability.logs.batching.maxRecords"
    )
    this.batchMaxBytes = positiveInteger(
      config.batching?.maxBytes ?? DEFAULT_LOG_BATCH_MAX_BYTES,
      "observability.logs.batching.maxBytes"
    )
    this.batchMaxDelayMs = nonNegativeInteger(
      config.batching?.maxDelayMs ?? DEFAULT_LOG_BATCH_MAX_DELAY_MS,
      "observability.logs.batching.maxDelayMs"
    )
    this.redactPaths = normalizeRedactPaths(config.redact?.paths ?? [])
    this.redactCensor = config.redact?.censor ?? "[REDACTED]"
    const censorReason = getInvalidJsonValueReason(
      this.redactCensor,
      "observability.logs.redact.censor"
    )
    if (censorReason) {
      throw new TypeError(censorReason)
    }

    if (this.maxBufferedBytes < this.maxRecordBytes) {
      throw new TypeError(
        "observability.logs.limits.maxBufferedBytes must be greater than or equal to maxRecordBytes"
      )
    }

    this.stream =
      options.stream ??
      ({
        ...LOGS_STREAM,
        retention: mergeLogsRetention(config.retention),
      } satisfies BrokerStreamDefinition)
  }

  /** Start the single logger session owned by one worker execution. */
  startExecution(run: LogRunRef): RunLogSession {
    return createRunLogSession({
      run,
      provider: this.provider,
      publish: this.publisher(),
      captureEnabled: this.captureEnabled,
      captureLevel: this.captureLevel,
      maxLinesPerExecution: this.maxLinesPerExecution,
      maxRecordBytes: this.maxRecordBytes,
      maxBufferedBytes: this.maxBufferedBytes,
      batchMaxRecords: this.batchMaxRecords,
      batchMaxBytes: this.batchMaxBytes,
      batchMaxDelayMs: this.batchMaxDelayMs,
      redactPaths: this.redactPaths,
      redactCensor: this.redactCensor,
    })
  }

  /** Flush the process provider. Execution sessions never call this globally. */
  async flush(): Promise<void> {
    await this.provider.flush?.()
  }

  /** Close the process provider. Lifecycle ownership stays outside handler loggers. */
  async close(): Promise<void> {
    if (this.provider.close) {
      await this.provider.close()
      return
    }
    await this.provider.flush?.()
  }

  private publisher(): LogPublisher | undefined {
    const broker = this.broker
    if (!broker || !this.captureEnabled) {
      return undefined
    }
    return async (records) => {
      await this.ensureStream()
      await broker.append({
        projectId: this.projectId,
        streamId: this.stream.id,
        records: records.map((record) => ({
          name: `${record.context.run.kind}.${record.level}`,
          key: `${record.context.run.kind}:${record.context.run.id}`,
          payload: record as unknown as JsonValue,
        })),
      })
    }
  }

  private ensureStream(): Promise<void> {
    const broker = this.broker
    if (!broker) {
      return Promise.resolve()
    }
    if (!this.ensureStreamPromise) {
      this.ensureStreamPromise = broker
        .ensureStream({ projectId: this.projectId, stream: this.stream })
        .catch((error) => {
          this.ensureStreamPromise = undefined
          throw error
        })
    }
    return this.ensureStreamPromise
  }
}

/** Resolve a worker runtime, falling back to a silent output-only runtime. */
export function resolveLogsRuntime(projectId: string, logs?: LogsRuntime): LogsRuntime {
  return logs ?? new LogsRuntime({ projectId, logger: noopLoggerProvider })
}

function normalizeRedactPaths(paths: readonly string[]): readonly string[] {
  const normalized = new Set<string>()
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new TypeError("observability.logs.redact.paths must contain non-empty strings")
    }
    normalized.add(path.trim())
  }
  return [...normalized]
}

function mergeLogsRetention(retention: BrokerRetention | undefined): BrokerRetention {
  return {
    maxAgeMs: nonNegativeInteger(
      retention?.maxAgeMs ?? DEFAULT_LOGS_RETENTION.maxAgeMs,
      "observability.logs.retention.maxAgeMs"
    ),
    maxRecords: nonNegativeInteger(
      retention?.maxRecords ?? DEFAULT_LOGS_RETENTION.maxRecords,
      "observability.logs.retention.maxRecords"
    ),
    maxBytes: nonNegativeInteger(
      retention?.maxBytes ?? DEFAULT_LOGS_RETENTION.maxBytes,
      "observability.logs.retention.maxBytes"
    ),
  }
}

function logLevel(value: LogLevel, path: string): LogLevel {
  if (value !== "debug" && value !== "info" && value !== "warn" && value !== "error") {
    throw new TypeError(`${path} must be one of: debug, info, warn, error`)
  }
  return value
}

function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`)
  }
  return value
}
