import type { JsonValue } from "../json"
import { sanitizeRecord, serializedBytes } from "./record"
import type {
  LogContext,
  LogEntry,
  LogFields,
  Logger,
  LoggerProvider,
  LogLevel,
  LogRecord,
  LogRunRef,
} from "./types"
import { isLevelEnabled, normalizeLogError } from "./types"

/** Publishes one ordered batch to the backing broker stream. */
export type LogPublisher = (records: readonly LogRecord[]) => Promise<void>

/** @internal Fixed broker-capture safeguards for one execution. */
export interface RunLogCaptureOptions {
  readonly publish: LogPublisher
  readonly level: LogLevel
  readonly maxLinesPerExecution: number
  readonly maxRecordBytes: number
  readonly maxBufferedBytes: number
  readonly batchMaxRecords: number
  readonly batchMaxBytes: number
  readonly batchMaxDelayMs: number
  readonly redactPaths: readonly string[]
  readonly redactCensor: JsonValue
}

/** @internal Dependencies used to create one execution-scoped log session. */
export interface RunLogSessionOptions {
  readonly run: LogRunRef
  readonly provider: LoggerProvider
  readonly capture?: RunLogCaptureOptions
}

type EmitLog = (
  level: LogLevel,
  message: string,
  fields: LogFields | undefined,
  context: Omit<LogContext, "run">
) => void

/**
 * Internal state and lifecycle for every handler logger created during one worker execution.
 *
 * Handler loggers are immutable views over this session. They all share its capture quota,
 * ordered broker queue, and final flush boundary.
 */
export class RunLogSession {
  readonly logger: Logger

  private captured = 0
  private droppedByLineLimit = 0
  private droppedByBackpressure = 0
  private pending: Array<{ readonly record: LogRecord; readonly bytes: number }> = []
  private pendingBytes = 0
  private bufferedBytes = 0
  private pumpPromise: Promise<void> | undefined
  private flushPromise: Promise<void> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private captureClosed = false
  private providerFailureReported = false
  private publisherFailureReported = false

  private readonly emitFromContext: EmitLog = (level, message, fields, context) => {
    this.emit(level, message, fields, context)
  }

  constructor(private readonly options: RunLogSessionOptions) {
    this.logger = new ContextLogger(this.emitFromContext, {}, {})
  }

  /** Derive a handler logger with immutable framework-owned metadata. */
  withContext(context: Omit<LogContext, "run">): Logger {
    return new ContextLogger(this.emitFromContext, {}, { ...context })
  }

  /** Flush this execution's broker capture. It never flushes or closes the process provider. */
  flush(): Promise<void> {
    this.flushPromise ??= this.flushCapture()
    return this.flushPromise
  }

  private emit(
    level: LogLevel,
    message: string,
    fields: LogFields | undefined,
    context: Omit<LogContext, "run">
  ): void {
    const entry: LogEntry = {
      level,
      message,
      ...(fields && safeKeys(fields).length > 0 ? { fields } : {}),
      at: new Date().toISOString(),
      context: { ...context, run: this.options.run },
    }

    this.writeToProvider(entry)

    const capture = this.options.capture
    if (this.captureClosed || !capture || !isLevelEnabled(level, capture.level)) {
      return
    }

    if (this.captured >= capture.maxLinesPerExecution) {
      this.droppedByLineLimit += 1
      return
    }

    const record = sanitizeRecord(entry, {
      maxBytes: capture.maxRecordBytes,
      redactPaths: capture.redactPaths,
      redactCensor: capture.redactCensor,
    })
    const bytes = serializedBytes(record)

    if (this.bufferedBytes + bytes > capture.maxBufferedBytes) {
      this.droppedByBackpressure += 1
      return
    }

    this.captured += 1
    this.pending.push({ record, bytes })
    this.pendingBytes += bytes
    this.bufferedBytes += bytes

    if (
      this.pending.length >= capture.batchMaxRecords ||
      this.pendingBytes >= capture.batchMaxBytes
    ) {
      this.startPump()
    } else {
      this.scheduleFlush()
    }
  }

  private async flushCapture(): Promise<void> {
    this.captureClosed = true

    // Drain ordinary records first so the truncation marker cannot exceed the hard buffer bound.
    this.startPump()
    await this.drain()
    this.enqueueTruncationMarker()
    this.startPump()
    await this.drain()
  }

  private async drain(): Promise<void> {
    while (this.pumpPromise || this.pending.length > 0) {
      this.startPump()
      const pump = this.pumpPromise
      if (!pump) {
        return
      }
      await pump
    }
  }

  private writeToProvider(entry: LogEntry): void {
    try {
      this.options.provider.write(entry)
    } catch (error) {
      if (!this.providerFailureReported) {
        this.providerFailureReported = true
        reportLoggingFailure("output provider", error)
      }
    }
  }

  private enqueueTruncationMarker(): void {
    const capture = this.options.capture
    const droppedLines = this.droppedByLineLimit + this.droppedByBackpressure
    if (droppedLines === 0 || !capture) {
      return
    }

    const marker = sanitizeRecord(
      {
        level: "warn",
        message: "log truncated",
        fields: {
          droppedLines,
          lineLimit: this.droppedByLineLimit,
          backpressure: this.droppedByBackpressure,
        },
        at: new Date().toISOString(),
        context: { run: this.options.run },
      },
      {
        maxBytes: capture.maxRecordBytes,
        redactPaths: [],
        redactCensor: capture.redactCensor,
      }
    )
    const bytes = serializedBytes(marker)
    if (bytes > capture.maxBufferedBytes) {
      reportLoggingFailure(
        "broker capture",
        new Error("The log truncation marker exceeds the internal capture buffer bound.")
      )
      return
    }
    this.pending.push({ record: marker, bytes })
    this.pendingBytes += bytes
    this.bufferedBytes += bytes
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return
    }
    const delay = this.options.capture?.batchMaxDelayMs
    if (delay === undefined) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.startPump()
    }, delay)
  }

  private startPump(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    const publish = this.options.capture?.publish
    if (this.pending.length === 0 || !publish || this.pumpPromise) {
      return
    }

    this.pumpPromise = this.pump(publish).finally(() => {
      this.pumpPromise = undefined
      if (this.pending.length > 0) {
        this.startPump()
      }
    })
  }

  private async pump(publish: LogPublisher): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.takeBatch()
      try {
        await publish(batch.records)
      } catch (error) {
        if (!this.publisherFailureReported) {
          this.publisherFailureReported = true
          reportLoggingFailure("broker capture", error)
        }
      } finally {
        this.bufferedBytes -= batch.bytes
      }
    }
  }

  private takeBatch(): { readonly records: readonly LogRecord[]; readonly bytes: number } {
    const capture = this.options.capture
    if (!capture) {
      return { records: [], bytes: 0 }
    }

    let count = 0
    let bytes = 0
    while (count < this.pending.length && count < capture.batchMaxRecords) {
      const next = this.pending[count]!
      if (count > 0 && bytes + next.bytes > capture.batchMaxBytes) {
        break
      }
      bytes += next.bytes
      count += 1
    }

    const items = this.pending.splice(0, count)
    this.pendingBytes -= bytes
    return { records: items.map((item) => item.record), bytes }
  }
}

/** Handler façade that binds user fields while preserving framework-owned context. */
class ContextLogger implements Logger {
  constructor(
    private readonly emit: EmitLog,
    private readonly fields: LogFields,
    private readonly context: Omit<LogContext, "run">
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.safeEmit("debug", message, fields)
  }

  info(message: string, fields?: LogFields): void {
    this.safeEmit("info", message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.safeEmit("warn", message, fields)
  }

  error(message: string | Error, fields?: LogFields): void {
    try {
      const normalized = normalizeLogError(message, this.merge(fields))
      this.emit("error", normalized.message, normalized.fields, this.context)
    } catch (error) {
      reportLoggingFailure("handler façade", error)
    }
  }

  child(bindings: LogFields): Logger {
    try {
      return new ContextLogger(this.emit, { ...this.fields, ...bindings }, this.context)
    } catch (error) {
      reportLoggingFailure("handler façade", error)
      return this
    }
  }

  private safeEmit(level: LogLevel, message: string, fields: LogFields | undefined): void {
    try {
      this.emit(level, message, this.merge(fields), this.context)
    } catch (error) {
      reportLoggingFailure("handler façade", error)
    }
  }

  private merge(fields: LogFields | undefined): LogFields | undefined {
    if (!fields || safeKeys(fields).length === 0) {
      return safeKeys(this.fields).length > 0 ? this.fields : undefined
    }
    return { ...this.fields, ...fields }
  }
}

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value)
  } catch {
    return []
  }
}

function reportLoggingFailure(destination: string, error: unknown): void {
  try {
    console.error(`[Sixb] Logging ${destination} failed:`, error)
  } catch {
    // Logging is best-effort and must never escape into project code.
  }
}
