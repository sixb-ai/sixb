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

interface RunLoggerCoreOptions {
  readonly run: LogRunRef
  readonly provider: LoggerProvider
  readonly publish?: LogPublisher
  readonly captureEnabled: boolean
  readonly captureLevel: LogLevel
  readonly maxLinesPerExecution: number
  readonly maxRecordBytes: number
  readonly maxBufferedBytes: number
  readonly batchMaxRecords: number
  readonly batchMaxBytes: number
  readonly batchMaxDelayMs: number
  readonly redactPaths: readonly string[]
  readonly redactCensor: JsonValue
}

/** Shared state for every handler logger created during one worker execution. */
class RunLoggerCore {
  private captured = 0
  private droppedByLineLimit = 0
  private droppedByBackpressure = 0
  private pending: Array<{ readonly record: LogRecord; readonly bytes: number }> = []
  private pendingBytes = 0
  private bufferedBytes = 0
  private pumpPromise: Promise<void> | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private captureClosed = false
  private providerFailureReported = false
  private publisherFailureReported = false

  constructor(private readonly options: RunLoggerCoreOptions) {}

  emit(
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

    if (
      this.captureClosed ||
      !this.options.publish ||
      !this.options.captureEnabled ||
      !isLevelEnabled(level, this.options.captureLevel)
    ) {
      return
    }

    if (this.captured >= this.options.maxLinesPerExecution) {
      this.droppedByLineLimit += 1
      return
    }

    const record = sanitizeRecord(entry, {
      maxBytes: this.options.maxRecordBytes,
      redactPaths: this.options.redactPaths,
      redactCensor: this.options.redactCensor,
    })
    const bytes = serializedBytes(record)

    if (this.bufferedBytes + bytes > this.options.maxBufferedBytes) {
      this.droppedByBackpressure += 1
      return
    }

    this.captured += 1
    this.pending.push({ record, bytes })
    this.pendingBytes += bytes
    this.bufferedBytes += bytes

    if (
      this.pending.length >= this.options.batchMaxRecords ||
      this.pendingBytes >= this.options.batchMaxBytes
    ) {
      this.startPump()
    } else {
      this.scheduleFlush()
    }
  }

  async flush(): Promise<void> {
    if (!this.captureClosed) {
      this.captureClosed = true
      this.enqueueTruncationMarker()
      this.startPump()
    }
    while (this.pumpPromise || this.pending.length > 0) {
      this.startPump()
      await this.pumpPromise
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
    const droppedLines = this.droppedByLineLimit + this.droppedByBackpressure
    if (droppedLines === 0 || !this.options.publish || !this.options.captureEnabled) {
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
        maxBytes: this.options.maxRecordBytes,
        redactPaths: [],
        redactCensor: this.options.redactCensor,
      }
    )
    const bytes = serializedBytes(marker)
    this.pending.push({ record: marker, bytes })
    this.pendingBytes += bytes
    this.bufferedBytes += bytes
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.startPump()
    }, this.options.batchMaxDelayMs)
  }

  private startPump(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.pending.length === 0 || !this.options.publish || this.pumpPromise) {
      return
    }

    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = undefined
      if (this.pending.length > 0) {
        this.startPump()
      }
    })
  }

  private async pump(): Promise<void> {
    const publish = this.options.publish
    if (!publish) {
      return
    }

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
    let count = 0
    let bytes = 0
    while (count < this.pending.length && count < this.options.batchMaxRecords) {
      const next = this.pending[count]!
      if (count > 0 && bytes + next.bytes > this.options.batchMaxBytes) {
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

/** Concrete handler façade: binds user fields and framework context separately. */
class RunLoggerImpl implements Logger {
  constructor(
    private readonly core: RunLoggerCore,
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
      this.core.emit("error", normalized.message, normalized.fields, this.context)
    } catch (error) {
      reportLoggingFailure("handler façade", error)
    }
  }

  child(bindings: LogFields): Logger {
    try {
      return new RunLoggerImpl(this.core, { ...this.fields, ...bindings }, this.context)
    } catch (error) {
      reportLoggingFailure("handler façade", error)
      return this
    }
  }

  private safeEmit(level: LogLevel, message: string, fields: LogFields | undefined): void {
    try {
      this.core.emit(level, message, this.merge(fields), this.context)
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

/** Worker-owned logger session. Exactly one instance represents one execution. */
export interface RunLogSession {
  readonly logger: Logger
  /** Derive a handler logger with immutable framework-owned metadata. */
  withContext(context: Omit<LogContext, "run">): Logger
  /** Flush captured broker batches. Does not flush or close the process provider. */
  flush(): Promise<void>
}

class RunLogSessionImpl implements RunLogSession {
  readonly logger: Logger

  constructor(private readonly core: RunLoggerCore) {
    this.logger = new RunLoggerImpl(core, {}, {})
  }

  /** Derive a handler logger with immutable framework-owned metadata. */
  withContext(context: Omit<LogContext, "run">): Logger {
    return new RunLoggerImpl(this.core, {}, { ...context })
  }

  /** Flush captured broker batches. Does not flush or close the process provider. */
  flush(): Promise<void> {
    return this.core.flush()
  }
}

export function createRunLogSession(options: RunLoggerCoreOptions): RunLogSession {
  return new RunLogSessionImpl(new RunLoggerCore(options))
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
