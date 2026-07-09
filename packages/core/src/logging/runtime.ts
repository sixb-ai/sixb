import type { Broker, BrokerStreamDefinition } from "../broker"
import { getInvalidJsonValueReason, type JsonValue } from "../json"
import { ConsoleLogger, noopLogger } from "./console-logger"
import { type LogPublisher, RunLoggerCore, RunLoggerImpl } from "./run-logger"
import { DEFAULT_MAX_LINES_PER_RUN, LOGS_STREAM } from "./stream"
import type { LogFields, Logger, LogRecord, LogRunRef, RunLogger } from "./types"

export interface LogsRuntimeOptions {
  readonly projectId: string
  /** Broker backing the `__logs` stream. Absent → logging is output-only. */
  readonly broker?: Broker
  /** Output sink for every line. Defaults to a {@link ConsoleLogger}. */
  readonly logger?: Logger
  /** Per-run line cap. Defaults to {@link DEFAULT_MAX_LINES_PER_RUN}. */
  readonly maxLinesPerRun?: number
  readonly stream?: BrokerStreamDefinition
}

/**
 * Project-scoped logging runtime backed by the shared broker — the logs
 * counterpart to `EventsRuntime`.
 *
 * `forRun(...)` mints the run-bound `ctx.logger` handlers use. Each line fans
 * out to the output sink (stdout) and, when a broker is configured, to the
 * `__logs` stream that powers Atlas. The read/subscribe side lands with the
 * client `logs` builder.
 */
export class LogsRuntime {
  private readonly projectId: string
  private readonly broker?: Broker
  private readonly output: Logger
  private readonly maxLinesPerRun: number
  private readonly stream: BrokerStreamDefinition
  private ensureStreamPromise?: Promise<void>

  constructor(options: LogsRuntimeOptions) {
    this.projectId = options.projectId
    this.broker = options.broker
    this.output = options.logger ?? new ConsoleLogger()
    this.maxLinesPerRun = options.maxLinesPerRun ?? DEFAULT_MAX_LINES_PER_RUN
    this.stream = options.stream ?? LOGS_STREAM
  }

  /** Mint a logger bound to `run`; `fields` are added to every line it emits. */
  forRun(run: LogRunRef, fields?: LogFields): RunLogger {
    const core = new RunLoggerCore(
      run,
      this.output.child({ run: { kind: run.kind, id: run.id } }),
      this.publisher(),
      this.maxLinesPerRun
    )
    return new RunLoggerImpl(core, fields ?? {})
  }

  private publisher(): LogPublisher | undefined {
    const broker = this.broker
    if (!broker) {
      return undefined
    }
    return async (records) => {
      await this.ensureStream()
      await broker.append({
        projectId: this.projectId,
        streamId: this.stream.id,
        records: records.map((record) => ({
          name: record.run.kind,
          key: record.run.id,
          payload: toBrokerPayload(record),
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

/**
 * Reach a worker's {@link LogsRuntime}, or a disabled output-only one when
 * unset. Production wires `sixb.logs`; minimal test/embedding contexts fall
 * back to a silent, broker-less logger so `ctx.logger` is always usable.
 */
export function resolveLogsRuntime(projectId: string, logs?: LogsRuntime): LogsRuntime {
  return logs ?? new LogsRuntime({ projectId, logger: noopLogger })
}

function toBrokerPayload(record: LogRecord): JsonValue {
  const reason = getInvalidJsonValueReason(record, "log record")
  if (!reason) {
    return record as unknown as JsonValue
  }
  // Never throw into a handler's logging path — drop the offending fields.
  return {
    level: record.level,
    message: record.message,
    at: record.at,
    run: { kind: record.run.kind, id: record.run.id },
    fields: { sixb_unloggableFields: reason },
  }
}
