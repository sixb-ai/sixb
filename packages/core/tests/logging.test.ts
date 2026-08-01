import { describe, expect, spyOn, test } from "bun:test"
import { InMemoryBroker } from "../src/broker"
import type { JsonValue } from "../src/json"
import {
  ConsoleLogger,
  isLevelEnabled,
  isLogRecord,
  isStoredLogLine,
  LOG_LEVELS,
  LOGS_STREAM,
  type LogEntry,
  type LoggerProvider,
  type LogLevel,
  type LogRecord,
  LogsRuntime,
  logLevelsAtOrAbove,
  noopLoggerProvider,
  resolveLogsRuntime,
  SIXB_RUN_KINDS,
} from "../src/logging"
import { type RunLogCaptureOptions, RunLogSession } from "../src/logging/run-logger"
import {
  DEFAULT_LOG_BATCH_MAX_BYTES,
  DEFAULT_LOG_BATCH_MAX_DELAY_MS,
  DEFAULT_LOG_BATCH_MAX_RECORDS,
  DEFAULT_LOG_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_LINES_PER_EXECUTION,
  DEFAULT_MAX_LOG_RECORD_BYTES,
} from "../src/logging/stream"

const PROJECT = "logging-tests"

async function readLines(broker: InMemoryBroker): Promise<readonly LogRecord[]> {
  const { records } = await broker.read({ projectId: PROJECT, streamId: LOGS_STREAM.id })
  return records.map((record) => record.payload as unknown as LogRecord)
}

function recordingProvider(): { provider: LoggerProvider; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    provider: { write: (entry) => entries.push(entry) },
    entries,
  }
}

describe("LogsRuntime broker capture", () => {
  test("publishes a routed, run-tagged record", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker })
    const session = logs.startExecution({ kind: "sync", id: "run-1" })

    session.logger.info("Reviewing invoice", { invoice: "INV-1" })
    await session.flush()

    const { records } = await broker.read({ projectId: PROJECT, streamId: LOGS_STREAM.id })
    expect(records).toHaveLength(1)
    expect(records[0]?.name).toBe("sync.info")
    expect(records[0]?.key).toBe("sync:run-1")
    expect(records[0]?.payload).toMatchObject({
      level: "info",
      message: "Reviewing invoice",
      fields: { invoice: "INV-1" },
      context: { run: { kind: "sync", id: "run-1" } },
    })
  })

  test("defaults to broker-only logging without an output provider", async () => {
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const broker = new InMemoryBroker()
      const logs = new LogsRuntime({ projectId: PROJECT, broker })
      const session = logs.startExecution({ kind: "sync", id: "broker-only" })

      session.logger.info("captured without stdout")
      await session.flush()

      expect(infoSpy).not.toHaveBeenCalled()
      expect((await readLines(broker)).map((line) => line.message)).toEqual([
        "captured without stdout",
      ])
    } finally {
      infoSpy.mockRestore()
    }
  })

  test("rejects malformed retained log records during hydration", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker })
    await broker.ensureStream({ projectId: PROJECT, stream: LOGS_STREAM })
    await broker.append({
      projectId: PROJECT,
      streamId: LOGS_STREAM.id,
      records: [
        {
          payload: {
            level: "info",
            message: "malformed",
            fields: [],
            at: "2026-07-11T00:00:00.000Z",
            context: { run: { kind: "workflow", id: "wf-1" } },
          },
        },
      ],
    })

    await expect(logs.read()).rejects.toThrow("is not a log line")
  })

  test("uses a capture level independent from the output provider", async () => {
    const broker = new InMemoryBroker()
    const { provider, entries } = recordingProvider()
    const logs = new LogsRuntime({
      projectId: PROJECT,
      broker,
      logger: provider,
      observability: { level: "warn" },
    })
    const session = logs.startExecution({ kind: "workflow", id: "run-2" })

    session.logger.debug("provider only")
    session.logger.warn("captured")
    await session.flush()

    expect(entries.map((entry) => entry.message)).toEqual(["provider only", "captured"])
    expect((await readLines(broker)).map((line) => line.message)).toEqual(["captured"])
  })

  test("caps one complete execution across step loggers", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({
      projectId: PROJECT,
      broker,
      logger: noopLoggerProvider,
      observability: { maxLinesPerExecution: 3 },
    })
    const session = logs.startExecution({ kind: "pipeline", id: "run-3" })

    for (const stepId of ["extract", "transform"]) {
      const logger = session.withContext({ stepId })
      for (let index = 0; index < 3; index += 1) {
        logger.info(`${stepId} ${index}`)
      }
    }
    await session.flush()

    const lines = await readLines(broker)
    expect(lines.map((line) => line.message)).toEqual([
      "extract 0",
      "extract 1",
      "extract 2",
      "log truncated",
    ])
    expect(lines[3]?.fields).toEqual({ droppedLines: 3, lineLimit: 3, backpressure: 0 })
  })

  test("keeps framework context separate from user bindings", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker, logger: noopLoggerProvider })
    const session = logs.startExecution({ kind: "workflow", id: "run-4" })

    session
      .withContext({ stepId: "review" })
      .child({ run: { kind: "sync", id: "spoofed" }, stepId: "spoofed" })
      .info("safe")
    await session.flush()

    const line = (await readLines(broker))[0]
    expect(line?.context).toEqual({
      run: { kind: "workflow", id: "run-4" },
      stepId: "review",
    })
    expect(line?.fields).toMatchObject({ stepId: "spoofed" })
  })

  test("normalizes errors and invalid fields without throwing", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker, logger: noopLoggerProvider })
    const session = logs.startExecution({ kind: "action", id: "run-5" })

    session.logger.error(new Error("boom"), { phase: "commit" })
    session.logger.info("invalid", { fn: (() => undefined) as unknown as JsonValue })
    await session.flush()

    const lines = await readLines(broker)
    expect(lines[0]?.message).toBe("boom")
    expect((lines[0]?.fields?.error as { name?: string } | undefined)?.name).toBe("Error")
    expect(typeof lines[1]?.fields?.sixb_unloggableFields).toBe("string")
  })

  test("redacts and byte-bounds only the broker copy", async () => {
    const broker = new InMemoryBroker()
    const { provider, entries } = recordingProvider()
    const logs = new LogsRuntime({
      projectId: PROJECT,
      broker,
      logger: provider,
      observability: {
        redact: { paths: ["credentials.token"] },
      },
    })
    const session = logs.startExecution({ kind: "sync", id: "run-6" })
    const body = "x".repeat(DEFAULT_MAX_LOG_RECORD_BYTES * 2)

    session.logger.info(body, { credentials: { token: "secret" }, body })
    await session.flush()

    expect(entries[0]?.message).toHaveLength(DEFAULT_MAX_LOG_RECORD_BYTES * 2)
    expect((entries[0]?.fields?.credentials as { token?: string } | undefined)?.token).toBe(
      "secret"
    )
    const line = (await readLines(broker))[0]!
    expect(new TextEncoder().encode(JSON.stringify(line)).byteLength).toBeLessThanOrEqual(
      DEFAULT_MAX_LOG_RECORD_BYTES
    )
    expect(line.fields).toMatchObject({ sixb_truncated: true })
  })

  test("redacts nested and wildcard field paths only in broker capture", async () => {
    const broker = new InMemoryBroker()
    const { provider, entries } = recordingProvider()
    const logs = new LogsRuntime({
      projectId: PROJECT,
      broker,
      logger: provider,
      observability: { redact: { paths: ["credentials.token", "users.*.email"] } },
    })
    const session = logs.startExecution({ kind: "sync", id: "run-redact" })

    session.logger.info("credentials", {
      credentials: { token: "secret" },
      users: [{ email: "ada@example.com" }, { email: "grace@example.com" }],
    })
    await session.flush()

    expect((entries[0]?.fields?.credentials as { token?: string }).token).toBe("secret")
    const fields = (await readLines(broker))[0]?.fields
    expect((fields?.credentials as { token?: string }).token).toBe("[REDACTED]")
    expect((fields?.users as Array<{ email?: string }>).map((user) => user.email)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
    ])
  })

  test("batches ordered broker appends", async () => {
    const batches: LogRecord[][] = []
    const session = new RunLogSession({
      run: { kind: "sync", id: "run-7" },
      provider: noopLoggerProvider,
      capture: captureOptions(
        async (records) => {
          batches.push([...records])
        },
        { batchMaxRecords: 4, batchMaxBytes: 1_000_000, batchMaxDelayMs: 60_000 }
      ),
    })

    for (let index = 0; index < 10; index += 1) {
      session.logger.info(`line ${index}`)
    }
    await session.flush()

    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 2])
    expect(batches.flat().map((line) => line.message)).toEqual(
      Array.from({ length: 10 }, (_, index) => `line ${index}`)
    )
  })

  test("keeps one publish in flight and bounds the truncation marker", async () => {
    const publisher = new BlockingPublisher()
    const session = new RunLogSession({
      run: { kind: "sync", id: "run-backpressure" },
      provider: noopLoggerProvider,
      capture: captureOptions(publisher.publish, {
        maxRecordBytes: 256,
        maxBufferedBytes: 512,
        batchMaxRecords: 1,
        batchMaxBytes: 256,
        batchMaxDelayMs: 60_000,
      }),
    })

    for (let index = 0; index < 20; index += 1) {
      session.logger.info(`line ${index}`)
    }
    const flushing = session.flush()
    await Bun.sleep(0)
    publisher.release()
    await flushing

    const lines = publisher.records
    expect(publisher.maxConcurrentPublishes).toBe(1)
    expect(lines.length).toBeLessThan(20)
    expect(Number(lines.at(-1)?.fields?.backpressure)).toBeGreaterThan(0)
    expect(publisher.maxBatchBytes).toBeLessThanOrEqual(512)
  })

  test("can disable broker forwarding without disabling the provider", async () => {
    const broker = new InMemoryBroker()
    const { provider, entries } = recordingProvider()
    const logs = new LogsRuntime({
      projectId: PROJECT,
      broker,
      logger: provider,
      observability: { enabled: false },
    })
    const session = logs.startExecution({ kind: "sync", id: "run-8" })

    session.logger.info("provider only")
    await session.flush()

    expect(entries).toHaveLength(1)
    expect((await broker.read({ projectId: PROJECT, streamId: LOGS_STREAM.id })).records).toEqual(
      []
    )
  })
})

describe("logging failure isolation and lifecycle", () => {
  test("validates observability limits and redaction config at startup", () => {
    expect(
      () =>
        new LogsRuntime({
          projectId: PROJECT,
          observability: { level: "fatal" as LogLevel },
        })
    ).toThrow("observability.logs.level")
    expect(
      () =>
        new LogsRuntime({
          projectId: PROJECT,
          observability: { retention: { maxBytes: -1 } },
        })
    ).toThrow("observability.logs.retention.maxBytes")
    expect(
      () =>
        new LogsRuntime({
          projectId: PROJECT,
          observability: { maxLinesPerExecution: -1 },
        })
    ).toThrow("observability.logs.maxLinesPerExecution")
    expect(
      () =>
        new LogsRuntime({
          projectId: PROJECT,
          observability: {
            redact: { paths: ["secret"], censor: new Date() as unknown as JsonValue },
          },
        })
    ).toThrow("observability.logs.redact.censor")
  })

  test("a throwing provider cannot fail a handler or block broker capture", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const broker = new InMemoryBroker()
      const logs = new LogsRuntime({
        projectId: PROJECT,
        broker,
        logger: {
          write() {
            throw new Error("sink failed")
          },
        },
      })
      const session = logs.startExecution({ kind: "sync", id: "run-9" })

      expect(() => session.logger.info("still captured")).not.toThrow()
      await session.flush()
      expect((await readLines(broker))[0]?.message).toBe("still captured")
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  test("provider flush and close are runtime responsibilities", async () => {
    const calls: string[] = []
    const logs = new LogsRuntime({
      projectId: PROJECT,
      logger: {
        write() {},
        flush: () => {
          calls.push("flush")
        },
        close: () => {
          calls.push("close")
        },
      },
    })
    const session = logs.startExecution({ kind: "sync", id: "run-10" })

    await session.flush()
    expect(calls).toEqual([])
    await logs.flush()
    await logs.close()
    expect(calls).toEqual(["flush", "close"])
  })
})

describe("ConsoleLogger", () => {
  test("drops entries below its provider level", () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined)
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const provider = new ConsoleLogger({ level: "info" })
      const context = { run: { kind: "sync" as const, id: "run" } }
      provider.write({ level: "debug", message: "dropped", at: new Date().toISOString(), context })
      provider.write({ level: "info", message: "kept", at: new Date().toISOString(), context })
      expect(debugSpy).not.toHaveBeenCalled()
      expect(infoSpy).toHaveBeenCalledTimes(1)
    } finally {
      debugSpy.mockRestore()
      infoSpy.mockRestore()
    }
  })
})

describe("resolveLogsRuntime", () => {
  test("returns the provided runtime unchanged", () => {
    const existing = new LogsRuntime({ projectId: PROJECT })
    expect(resolveLogsRuntime(PROJECT, existing)).toBe(existing)
  })

  test("falls back to a usable silent runtime", async () => {
    const session = resolveLogsRuntime(PROJECT).startExecution({ kind: "sync", id: "run-11" })
    session.logger.info("still works")
    await expect(session.flush()).resolves.toBeUndefined()
  })
})

describe("log metadata", () => {
  test("uses one canonical severity ordering", () => {
    expect(LOG_LEVELS).toEqual(["debug", "info", "warn", "error"])
    expect(logLevelsAtOrAbove("debug")).toEqual(["debug", "info", "warn", "error"])
    expect(logLevelsAtOrAbove("info")).toEqual(["info", "warn", "error"])
    expect(logLevelsAtOrAbove("warn")).toEqual(["warn", "error"])
    expect(logLevelsAtOrAbove("error")).toEqual(["error"])
    expect(isLevelEnabled("warn", "info")).toBe(true)
    expect(isLevelEnabled("debug", "info")).toBe(false)
    expect(isLevelEnabled("debug", "fatal" as LogLevel)).toBe(false)
    expect(logLevelsAtOrAbove("fatal" as LogLevel)).toEqual([])
  })

  test("exposes the canonical run kinds", () => {
    // Everything here has a run record with an id. Rules do not — they are evaluated live per
    // subject — which is why they are absent and report as `rule.evaluation.failed` instead.
    expect(SIXB_RUN_KINDS).toEqual([
      "action",
      "agent",
      "pipeline",
      "projection",
      "sync",
      "webhook",
      "workflow",
    ])
  })

  test("validates complete log records and stored lines", () => {
    const valid = {
      level: "info",
      message: "validated",
      fields: { nested: [1, true, null] },
      at: "2026-07-11T00:00:00.000Z",
      context: {
        run: { kind: "workflow", id: "wf-1" },
        stepId: "step-1",
        phase: "execute",
        attempt: 1,
      },
    }

    expect(isLogRecord(valid)).toBe(true)
    expect(isStoredLogLine({ ...valid, cursor: "1" })).toBe(true)
    expect(isStoredLogLine(valid)).toBe(false)
    expect(isLogRecord({ ...valid, level: "fatal" })).toBe(false)
    expect(
      isLogRecord({ ...valid, context: { ...valid.context, run: { kind: "dataset", id: "d1" } } })
    ).toBe(false)
    expect(isLogRecord({ ...valid, fields: [] })).toBe(false)
    expect(isLogRecord({ ...valid, fields: { invalid: new Date() } })).toBe(false)
    expect(isLogRecord({ ...valid, context: { ...valid.context, attempt: "1" } })).toBe(false)
  })
})

function captureOptions(
  publish: RunLogCaptureOptions["publish"],
  overrides: Partial<RunLogCaptureOptions> = {}
): RunLogCaptureOptions {
  return {
    publish,
    level: "debug",
    maxLinesPerExecution: DEFAULT_MAX_LINES_PER_EXECUTION,
    maxRecordBytes: DEFAULT_MAX_LOG_RECORD_BYTES,
    maxBufferedBytes: DEFAULT_LOG_MAX_BUFFERED_BYTES,
    batchMaxRecords: DEFAULT_LOG_BATCH_MAX_RECORDS,
    batchMaxBytes: DEFAULT_LOG_BATCH_MAX_BYTES,
    batchMaxDelayMs: DEFAULT_LOG_BATCH_MAX_DELAY_MS,
    redactPaths: [],
    redactCensor: "[REDACTED]",
    ...overrides,
  }
}

class BlockingPublisher {
  private readonly gate: Promise<void>
  private releaseGate: () => void = () => undefined
  private activePublishes = 0
  readonly records: LogRecord[] = []
  maxConcurrentPublishes = 0
  maxBatchBytes = 0

  constructor() {
    this.gate = new Promise((resolve) => {
      this.releaseGate = resolve
    })
  }

  release(): void {
    this.releaseGate()
  }

  readonly publish = async (records: readonly LogRecord[]): Promise<void> => {
    this.activePublishes += 1
    this.maxConcurrentPublishes = Math.max(this.maxConcurrentPublishes, this.activePublishes)
    try {
      await this.gate
      this.records.push(...records)
      this.maxBatchBytes = Math.max(
        this.maxBatchBytes,
        records.reduce(
          (total, record) => total + new TextEncoder().encode(JSON.stringify(record)).byteLength,
          0
        )
      )
    } finally {
      this.activePublishes -= 1
    }
  }
}
