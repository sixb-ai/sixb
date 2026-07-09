import {
  type LogFields,
  type Logger,
  type LogLevel,
  type LogRecord,
  type LogRunRef,
  normalizeLogError,
  type RunLogger,
} from "./types"

/** Publishes log records to the backing broker stream (batched). */
export type LogPublisher = (records: readonly LogRecord[]) => Promise<void>

/**
 * Shared, run-scoped state behind a {@link RunLogger} and its children.
 *
 * Owns the per-run line cap, the ordered publish tail (so live tail stays
 * in order), and the run-bound output sink. One core per run; `child()` wraps
 * the same core with extra fields.
 */
export class RunLoggerCore {
  private emitted = 0
  private dropped = 0
  private truncationEmitted = false
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly run: LogRunRef,
    private readonly output: Logger,
    private readonly publish: LogPublisher | undefined,
    private readonly maxLinesPerRun: number
  ) {}

  emit(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (this.emitted >= this.maxLinesPerRun) {
      this.dropped += 1
      return
    }
    this.emitted += 1
    this.deliver(level, message, fields)
  }

  async flush(): Promise<void> {
    if (this.dropped > 0 && !this.truncationEmitted) {
      this.truncationEmitted = true
      this.deliver("warn", "log truncated", { droppedLines: this.dropped })
    }
    await this.tail
  }

  private deliver(level: LogLevel, message: string, fields: LogFields | undefined): void {
    // The output sink self-gates by level; the broker keeps every line.
    switch (level) {
      case "debug":
        this.output.debug(message, fields)
        break
      case "info":
        this.output.info(message, fields)
        break
      case "warn":
        this.output.warn(message, fields)
        break
      case "error":
        this.output.error(message, fields)
        break
    }

    if (!this.publish) {
      return
    }
    const record: LogRecord = {
      level,
      message,
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
      at: new Date().toISOString(),
      run: this.run,
    }
    const publish = this.publish
    this.tail = this.tail
      .then(() => publish([record]))
      .then(
        () => undefined,
        // Swallow publish failures — logging must never surface into a handler.
        () => undefined
      )
  }
}

/** Concrete {@link RunLogger}: binds fields and delegates to a shared core. */
export class RunLoggerImpl implements RunLogger {
  constructor(
    private readonly core: RunLoggerCore,
    private readonly fields: LogFields
  ) {}

  debug(message: string, fields?: LogFields): void {
    this.core.emit("debug", message, this.merge(fields))
  }

  info(message: string, fields?: LogFields): void {
    this.core.emit("info", message, this.merge(fields))
  }

  warn(message: string, fields?: LogFields): void {
    this.core.emit("warn", message, this.merge(fields))
  }

  error(message: string | Error, fields?: LogFields): void {
    const normalized = normalizeLogError(message, this.merge(fields))
    this.core.emit("error", normalized.message, normalized.fields)
  }

  child(bindings: LogFields): RunLogger {
    return new RunLoggerImpl(this.core, { ...this.fields, ...bindings })
  }

  flush(): Promise<void> {
    return this.core.flush()
  }

  private merge(fields: LogFields | undefined): LogFields | undefined {
    if (!fields || Object.keys(fields).length === 0) {
      return Object.keys(this.fields).length > 0 ? this.fields : undefined
    }
    return { ...this.fields, ...fields }
  }
}
