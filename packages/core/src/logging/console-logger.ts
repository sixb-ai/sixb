import {
  isLevelEnabled,
  type LogFields,
  type Logger,
  type LogLevel,
  normalizeLogError,
} from "./types"

/** Options for {@link ConsoleLogger}. */
export interface ConsoleLoggerOptions {
  /** Lines below this level are not printed. Defaults to `"info"`. */
  readonly level?: LogLevel
  /** Fields merged into every line — set by {@link ConsoleLogger.child}. */
  readonly bindings?: LogFields
}

const CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
}

/**
 * Default output logger: prints to the console, gated by `level`.
 *
 * This is only the stdout side of `ctx.logger`. The broker side is always on
 * (see LogsRuntime), so `level` controls console verbosity — not what Atlas can
 * show.
 */
export class ConsoleLogger implements Logger {
  readonly level: LogLevel
  private readonly bindings: LogFields

  constructor(options: ConsoleLoggerOptions = {}) {
    this.level = options.level ?? "info"
    this.bindings = options.bindings ?? {}
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields)
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields)
  }

  error(message: string | Error, fields?: LogFields): void {
    const normalized = normalizeLogError(message, fields)
    this.write("error", normalized.message, normalized.fields)
  }

  child(bindings: LogFields): ConsoleLogger {
    return new ConsoleLogger({ level: this.level, bindings: { ...this.bindings, ...bindings } })
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (!isLevelEnabled(level, this.level)) {
      return
    }
    const merged = { ...this.bindings, ...fields }
    const suffix = Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : ""
    console[CONSOLE_METHOD[level]](`${level.toUpperCase()} ${message}${suffix}`)
  }
}

/** A logger that discards everything — the sink when logging is unconfigured. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
}
