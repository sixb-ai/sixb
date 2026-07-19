import { describe, expect, spyOn, test } from "bun:test"
import type { SixbErrorContext } from "../src"
import {
  attachSixbErrorReporter,
  flushSixbErrors,
  normalizeReportedError,
  reportRunFailure,
} from "../src/error-reporting/internal"

const PROJECT_ID = "error-reporting-tests"

describe("Sixb error reporting", () => {
  test("reports a normalized terminal run failure with stable context", async () => {
    const host = {}
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })

    reportRunFailure(host, "projection exploded", {
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      attempt: 2,
      run: {
        kind: "projection",
        runId: "projection-run-1",
        projectionId: "rooms",
        projectionKind: "object",
      },
    })
    await flushSixbErrors(host)

    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBeInstanceOf(Error)
    expect(reports[0]?.error.message).toBe("projection exploded")
    expect(reports[0]?.context).toEqual({
      type: "run.failed",
      notificationId:
        "project:error-reporting-tests:run:projection:projection-run-1:failed:2026-01-02T03:04:05.000Z",
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      attempt: 2,
      run: {
        kind: "projection",
        runId: "projection-run-1",
        projectionId: "rooms",
        projectionKind: "object",
      },
    })
  })

  test("preserves Error identity", () => {
    const original = new Error("boom")
    expect(normalizeReportedError(original)).toBe(original)
  })

  test("normalizes cross-realm-like errors and hostile thrown values", () => {
    const errorLike = normalizeReportedError({ name: "ProviderError", message: "offline" })
    expect(errorLike.name).toBe("ProviderError")
    expect(errorLike.message).toBe("offline")

    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("getter failed")
      },
    })
    expect(normalizeReportedError(hostile).message).toBe("Unknown thrown value")
  })

  test("isolates callback rejection from framework execution", async () => {
    const host = {}
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    attachSixbErrorReporter(host, async () => {
      throw new Error("notification unavailable")
    })

    expect(() =>
      reportRunFailure(host, new Error("run failed"), {
        projectId: PROJECT_ID,
        run: { kind: "sync", runId: "sync-run-1", syncId: "customers" },
      })
    ).not.toThrow()
    await flushSixbErrors(host)

    expect(consoleError).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  test("flush drains reports added while a handler is running", async () => {
    const host = {}
    const messages: string[] = []
    attachSixbErrorReporter(host, (error) => {
      messages.push(error.message)
      if (error.message === "first") {
        reportRunFailure(host, new Error("second"), {
          projectId: PROJECT_ID,
          run: { kind: "sync", runId: "sync-run-2", syncId: "customers" },
        })
      }
    })

    reportRunFailure(host, new Error("first"), {
      projectId: PROJECT_ID,
      run: { kind: "sync", runId: "sync-run-1", syncId: "customers" },
    })
    await flushSixbErrors(host)

    expect(messages).toEqual(["first", "second"])
  })

  test("flush stops waiting after its timeout", async () => {
    const host = {}
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    attachSixbErrorReporter(host, () => new Promise<void>(() => {}))
    reportRunFailure(host, new Error("run failed"), {
      projectId: PROJECT_ID,
      run: { kind: "agent", runId: "agent-run-1", agentId: "assistant" },
    })

    await flushSixbErrors(host, 5)

    expect(consoleError).toHaveBeenCalledWith(
      "[Sixb] Timed out after 5ms waiting for 1 onError handler(s)."
    )
    consoleError.mockRestore()
  })

  test("is a no-op when no reporter is attached", async () => {
    const host = {}
    reportRunFailure(host, new Error("ignored"), {
      projectId: PROJECT_ID,
      run: { kind: "workflow", runId: "workflow-run-1", workflowId: "approval" },
    })
    await expect(flushSixbErrors(host)).resolves.toBeUndefined()
  })
})
