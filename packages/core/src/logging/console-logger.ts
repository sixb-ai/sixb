import {
  isLevelEnabled,
  type LogEntry,
  type Logger,
  type LoggerProvider,
  type LogLevel,
} from "./types"

/** Options for {@link ConsoleLogger}. */
export interface ConsoleLoggerOptions {
  /** Entries below this level are not printed. Defaults to `"info"`. */
  readonly level?: LogLevel
}

const CONSOLE_METHOD: Record<LogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
}

/** Opt-in console output provider. Broker capture is configured independently. */
export class ConsoleLogger implements LoggerProvider {
  readonly level: LogLevel

  constructor(options: ConsoleLoggerOptions = {}) {
    this.level = options.level ?? "info"
  }

  write(entry: LogEntry): void {
    if (!isLevelEnabled(entry.level, this.level)) {
      return
    }

    let suffix = ""
    try {
      suffix = ` ${JSON.stringify({
        ...(entry.fields ?? {}),
        sixb: entry.context,
      })}`
    } catch {
      suffix = ` ${JSON.stringify({ sixb: entry.context, sixb_unloggableFields: true })}`
    }

    console[CONSOLE_METHOD[entry.level]](`${entry.level.toUpperCase()} ${entry.message}${suffix}`)
  }
}

/** Output provider used by minimal worker contexts with no configured runtime. */
export const noopLoggerProvider: LoggerProvider = {
  write() {},
}

/** Handler façade used by tests and contexts where logging is intentionally absent. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
}
