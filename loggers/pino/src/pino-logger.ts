import type { LogEntry, LoggerProvider, LogLevel } from "@sixb/core"
import { type LoggerOptions, type Logger as Pino, pino } from "pino"

/** Options for {@link PinoLogger}. */
export interface PinoLoggerOptions {
  /** Minimum output level. Defaults to `"info"`; ignored when `instance` is provided. */
  readonly level?: LogLevel
  /** Reuse an already-configured Pino instance (transports, redaction, destinations). */
  readonly instance?: Pino
  /** Pino options used only when this provider creates the instance. */
  readonly options?: LoggerOptions
}

/** Process-level Sixb output provider backed by Pino structured logging. */
export class PinoLogger implements LoggerProvider {
  private readonly pino: Pino

  constructor(options: PinoLoggerOptions = {}) {
    this.pino =
      options.instance ??
      pino({
        ...options.options,
        level: options.level ?? options.options?.level ?? "info",
      })
  }

  write(entry: LogEntry): void {
    this.pino[entry.level](
      {
        ...(entry.fields ?? {}),
        // Framework metadata wins over a colliding user field.
        sixb: entry.context,
      },
      entry.message
    )
  }

  /** Flush Pino without taking ownership of an injected destination. */
  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.pino.flush((error) => {
          if (error) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  close(): Promise<void> {
    return this.flush()
  }
}
