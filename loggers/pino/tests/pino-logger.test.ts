import { describe, expect, test } from "bun:test"
import type { LogEntry } from "@sixb/core"
import { type Logger as Pino, pino } from "pino"
import { PinoLogger } from "../src"

function capture(level = "debug") {
  const lines: Array<Record<string, unknown>> = []
  const sink = {
    write(chunk: string) {
      for (const line of chunk.split("\n")) {
        if (line) lines.push(JSON.parse(line))
      }
    },
  }
  const provider = new PinoLogger({ instance: pino({ level }, sink) })
  return { provider, lines }
}

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    level: "info",
    message: "started",
    at: "2026-07-10T10:00:00.000Z",
    context: { run: { kind: "sync", id: "s_1" } },
    ...overrides,
  }
}

describe("PinoLogger", () => {
  test("maps provider entries to Pino levels without flattening framework context", () => {
    const { provider, lines } = capture()
    provider.write(entry({ fields: { step: "load", sixb: "user-value" } }))
    // Error fields arrive already normalized by the handler facade and pass through unchanged.
    provider.write(
      entry({
        level: "error",
        message: "boom",
        fields: { where: "commit", error: { name: "Error", stack: "stack" } },
      })
    )

    expect(lines).toHaveLength(2)
    expect(lines[0]?.msg).toBe("started")
    expect(lines[0]?.step).toBe("load")
    expect(lines[0]?.sixb).toEqual({ run: { kind: "sync", id: "s_1" } })
    expect(lines[0]?.level).toBe(30)
    expect(lines[1]?.msg).toBe("boom")
    expect(lines[1]?.where).toBe("commit")
    expect(lines[1]?.error).toEqual({ name: "Error", stack: "stack" })
    expect(lines[1]?.level).toBe(50)
  })

  test("honors the configured Pino instance level", () => {
    const { provider, lines } = capture("warn")
    provider.write(entry({ level: "info", message: "skipped" }))
    provider.write(entry({ level: "error", message: "kept" }))
    expect(lines.map((line) => line.msg)).toEqual(["kept"])
  })

  test("close propagates flush failures", async () => {
    const failure = new Error("flush failed")
    const instance = {
      flush(callback: (error?: Error) => void) {
        callback(failure)
      },
    } as unknown as Pino

    await expect(new PinoLogger({ instance }).close()).rejects.toBe(failure)
  })
})
