import { describe, expect, spyOn, test } from "bun:test"
import { InMemoryBroker } from "../src/broker"
import type { JsonValue } from "../src/json"
import {
  ConsoleLogger,
  LOGS_STREAM,
  type LogFields,
  type Logger,
  type LogRecord,
  LogsRuntime,
  resolveLogsRuntime,
} from "../src/logging"

const PROJECT = "logging-tests"

async function readLines(broker: InMemoryBroker): Promise<readonly LogRecord[]> {
  const records = await broker.read({ projectId: PROJECT, streamId: LOGS_STREAM.id })
  return records.map((record) => record.payload as unknown as LogRecord)
}

/** A `Logger` that records every line (and its child bindings) into `lines`. */
function recordingLogger(): {
  logger: Logger
  lines: { level: string; message: string; fields?: LogFields }[]
} {
  const lines: { level: string; message: string; fields?: LogFields }[] = []
  const make = (bound: LogFields): Logger => ({
    debug: (message, fields) =>
      lines.push({ level: "debug", message, fields: { ...bound, ...fields } }),
    info: (message, fields) =>
      lines.push({ level: "info", message, fields: { ...bound, ...fields } }),
    warn: (message, fields) =>
      lines.push({ level: "warn", message, fields: { ...bound, ...fields } }),
    error: (message, fields) =>
      lines.push({ level: "error", message: String(message), fields: { ...bound, ...fields } }),
    child: (bindings) => make({ ...bound, ...bindings }),
  })
  return { logger: make({}), lines }
}

describe("LogsRuntime broker publishing", () => {
  test("publishes a run-tagged record to the __logs stream", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker })

    const logger = logs.forRun({ kind: "sync", id: "run-1" })
    logger.info("Reviewing invoice", { invoice: "INV-1" })
    await logger.flush()

    const records = await broker.read({ projectId: PROJECT, streamId: LOGS_STREAM.id })
    expect(records).toHaveLength(1)
    expect(records[0]?.name).toBe("sync")
    expect(records[0]?.key).toBe("run-1")

    const line = records[0]?.payload as unknown as LogRecord
    expect(line.level).toBe("info")
    expect(line.message).toBe("Reviewing invoice")
    expect(line.fields).toEqual({ invoice: "INV-1" })
    expect(line.run).toEqual({ kind: "sync", id: "run-1" })
    expect(typeof line.at).toBe("string")
  })

  test("keeps every level on the broker regardless of the output logger level", async () => {
    const broker = new InMemoryBroker()
    // Output logger silences everything below error; the broker must still get debug.
    const logs = new LogsRuntime({
      projectId: PROJECT,
      broker,
      logger: new ConsoleLogger({ level: "error" }),
    })

    const logger = logs.forRun({ kind: "workflow", id: "run-2" })
    logger.debug("verbose detail")
    await logger.flush()

    const lines = await readLines(broker)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe("debug")
  })

  test("caps lines per run and emits a single truncation marker", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker, maxLinesPerRun: 3 })

    const logger = logs.forRun({ kind: "sync", id: "run-3" })
    for (let index = 0; index < 10; index += 1) {
      logger.info(`line ${index}`)
    }
    await logger.flush()

    const lines = await readLines(broker)
    expect(lines).toHaveLength(4)
    expect(lines.slice(0, 3).map((line) => line.message)).toEqual(["line 0", "line 1", "line 2"])
    expect(lines[3]?.message).toBe("log truncated")
    expect(lines[3]?.fields).toEqual({ droppedLines: 7 })
  })

  test("normalizes an Error into a message plus structured fields", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker })

    const logger = logs.forRun({ kind: "action", id: "run-4" })
    logger.error(new Error("boom"), { step: "commit" })
    await logger.flush()

    const lines = await readLines(broker)
    const line = lines[0]
    expect(line?.level).toBe("error")
    expect(line?.message).toBe("boom")
    expect(line?.fields?.step).toBe("commit")
    expect((line?.fields?.error as { name?: string } | undefined)?.name).toBe("Error")
  })

  test("child loggers merge bound fields and share the run", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker })

    const logger = logs.forRun({ kind: "pipeline", id: "run-5" }, { step: "extract" })
    logger.child({ attempt: 2 }).info("progress", { pct: 50 })
    await logger.flush()

    const line = (await readLines(broker))[0]
    expect(line?.fields).toEqual({ step: "extract", attempt: 2, pct: 50 })
    expect(line?.run).toEqual({ kind: "pipeline", id: "run-5" })
  })

  test("falls back to a marker when fields are not JSON-serializable", async () => {
    const broker = new InMemoryBroker()
    const logs = new LogsRuntime({ projectId: PROJECT, broker })

    const logger = logs.forRun({ kind: "sync", id: "run-6" })
    logger.info("bad fields", { fn: (() => undefined) as unknown as JsonValue })
    await logger.flush()

    const line = (await readLines(broker))[0]
    expect(typeof line?.fields?.sixb_unloggableFields).toBe("string")
  })
})

describe("LogsRuntime output fan-out", () => {
  test("forwards each line to the output logger, bound to the run", () => {
    const broker = new InMemoryBroker()
    const { logger: output, lines } = recordingLogger()
    const logs = new LogsRuntime({ projectId: PROJECT, broker, logger: output })

    logs.forRun({ kind: "sync", id: "run-7" }).info("hello", { a: 1 })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.message).toBe("hello")
    expect(lines[0]?.fields).toMatchObject({ run: { kind: "sync", id: "run-7" }, a: 1 })
  })

  test("works output-only when no broker is configured", async () => {
    const { logger: output, lines } = recordingLogger()
    const logs = new LogsRuntime({ projectId: PROJECT, logger: output })

    const logger = logs.forRun({ kind: "sync", id: "run-8" })
    logger.info("no broker here")
    await logger.flush()

    expect(lines).toHaveLength(1)
    expect(lines[0]?.message).toBe("no broker here")
  })
})

describe("ConsoleLogger", () => {
  test("drops lines below its level", () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined)
    const infoSpy = spyOn(console, "info").mockImplementation(() => undefined)
    try {
      const logger = new ConsoleLogger({ level: "info" })
      logger.debug("dropped")
      logger.info("kept")
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

  test("falls back to a usable, silent, broker-less runtime", async () => {
    const logs = resolveLogsRuntime(PROJECT)
    const logger = logs.forRun({ kind: "sync", id: "run-9" })
    logger.info("still works")
    await expect(logger.flush()).resolves.toBeUndefined()
  })
})
