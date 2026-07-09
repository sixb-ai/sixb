import { listLogs } from "./generated"
import type { Client } from "./generated/client"
import type { LogLevel, LogRunKind, LogRunRef, SixbLogLine } from "./logs-model"
import { createLogSocket, type LogSocketState } from "./logs-transport"

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"]

export interface LogsFilterIR {
  readonly kinds?: readonly LogRunKind[]
  readonly run?: LogRunRef
  readonly level?: LogLevel
}

export interface LogSubscribeOptions {
  readonly afterCursor?: string
  readonly reconnect?: boolean
  readonly reconnectDelayMs?: number
  readonly onError?: (error: string) => void
  readonly onReset?: (cursor?: string) => void
  readonly onStateChange?: (state: LogSocketState) => void
}

export interface LogsReadOptions {
  readonly afterCursor?: string
  readonly limit?: number
}

export interface LogsTailOptions {
  readonly beforeCursor?: string
  readonly limit?: number
}

export interface SixbLogsPage {
  readonly lines: readonly SixbLogLine[]
  /** Forward cursor for `.read()`, backward pagination cursor for `.tail()`. */
  readonly cursor?: string
  readonly hasMore: boolean
}

export interface SixbLogsClientOptions {
  /** Authenticated hey-api client override. Defaults to the global client. */
  readonly client?: Client
}

export interface LogsBuilder {
  readonly ir: LogsFilterIR
  level(level: LogLevel): LogsBuilder
  subscribe(handler: (line: SixbLogLine) => void, options?: LogSubscribeOptions): () => void
  read(options?: LogsReadOptions): Promise<SixbLogsPage>
  tail(options?: LogsTailOptions): Promise<SixbLogsPage>
}

export interface RunScopedLogsBuilder extends LogsBuilder {
  run(runId: string): LogsBuilder
}

class LogsBuilderImpl implements RunScopedLogsBuilder {
  constructor(
    readonly ir: LogsFilterIR,
    private readonly options?: SixbLogsClientOptions
  ) {}

  run(runId: string): LogsBuilder {
    const kind = this.ir.kinds?.[0]
    if (!kind) {
      throw new Error("run() is only available after selecting a log run kind")
    }
    return this.withFilter({ run: { kind, id: runId } })
  }

  level(level: LogLevel): LogsBuilder {
    return this.withFilter({ level })
  }

  subscribe(handler: (line: SixbLogLine) => void, options?: LogSubscribeOptions): () => void {
    const socket = createLogSocket({
      kinds: this.ir.kinds,
      run: this.ir.run,
      levels: this.ir.level ? levelsAtOrAbove(this.ir.level) : undefined,
      afterCursor: options?.afterCursor,
      reconnect: options?.reconnect,
      reconnectDelayMs: options?.reconnectDelayMs,
      client: this.options?.client,
      onLog: handler,
      onError: options?.onError,
      onReset: options?.onReset,
      onStateChange: options?.onStateChange,
    })
    return () => socket.close()
  }

  async read(options?: LogsReadOptions): Promise<SixbLogsPage> {
    return this.fetchPage({
      direction: "forward",
      afterCursor: options?.afterCursor,
      limit: options?.limit,
    })
  }

  async tail(options?: LogsTailOptions): Promise<SixbLogsPage> {
    return this.fetchPage({
      direction: "backward",
      beforeCursor: options?.beforeCursor,
      limit: options?.limit,
    })
  }

  private async fetchPage(input: {
    readonly direction: "forward" | "backward"
    readonly afterCursor?: string
    readonly beforeCursor?: string
    readonly limit?: number
  }): Promise<SixbLogsPage> {
    const { data } = await listLogs({
      query: {
        kind: this.ir.run?.kind ?? this.ir.kinds?.[0],
        runId: this.ir.run?.id,
        level: this.ir.level,
        direction: input.direction,
        afterCursor: input.afterCursor,
        beforeCursor: input.beforeCursor,
        limit: input.limit === undefined ? undefined : String(input.limit),
      },
      ...(this.options?.client ? { client: this.options.client } : {}),
      throwOnError: true,
    })
    return {
      lines: (data?.lines ?? []) as unknown as SixbLogLine[],
      cursor: data?.cursor,
      hasMore: data?.hasMore ?? false,
    }
  }

  private withFilter(delta: Partial<LogsFilterIR>): LogsBuilderImpl {
    return new LogsBuilderImpl({ ...this.ir, ...delta }, this.options)
  }
}

function createBuilder(ir: LogsFilterIR, options?: SixbLogsClientOptions): LogsBuilderImpl {
  return new LogsBuilderImpl(ir, options)
}

export interface SixbLogsApi {
  all(options?: SixbLogsClientOptions): LogsBuilder
  syncs(options?: SixbLogsClientOptions): RunScopedLogsBuilder
  pipelines(options?: SixbLogsClientOptions): RunScopedLogsBuilder
  workflows(options?: SixbLogsClientOptions): RunScopedLogsBuilder
  actions(options?: SixbLogsClientOptions): RunScopedLogsBuilder
}

export const logs: SixbLogsApi = {
  all: (options) => createBuilder({}, options),
  syncs: (options) => createBuilder({ kinds: ["sync"] }, options),
  pipelines: (options) => createBuilder({ kinds: ["pipeline"] }, options),
  workflows: (options) => createBuilder({ kinds: ["workflow"] }, options),
  actions: (options) => createBuilder({ kinds: ["action"] }, options),
}

function levelsAtOrAbove(level: LogLevel): readonly LogLevel[] {
  return LOG_LEVELS.slice(LOG_LEVELS.indexOf(level))
}
