import { describe, expect, spyOn, test } from "bun:test"
import type { SixbErrorContext } from "../src"
import type { Broker } from "../src/broker"
import {
  attachSixbErrorReporter,
  type ErrorReporter,
  flushSixbErrors,
  normalizeReportedError,
  reportEventDeliveryFailure,
  reportRuleEvaluationFailure,
  reportRunFailure,
  SixbErrorReporter,
} from "../src/error-reporting/internal"
import { DomainEventService } from "../src/events"

const PROJECT_ID = "error-reporting-tests"
const OCCURRED_AT = "2026-07-29T12:00:00.000Z"

function unexpectedFailure(message: string, at = OCCURRED_AT) {
  return {
    code: "internal.unexpected" as const,
    message,
    retryable: false,
    at,
  }
}

describe("Sixb error reporting", () => {
  test("reports a normalized terminal run failure with stable context", async () => {
    const host = {}
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })

    const failure = unexpectedFailure("projection exploded", "2026-01-02T03:04:05.000Z")
    reportRunFailure(host, "projection exploded", {
      projectId: PROJECT_ID,
      attempt: 2,
      runKind: "projection",
      run: {
        runId: "projection-run-1",
        projectionId: "rooms",
        projectionKind: "object",
      },
      failure,
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
      runKind: "projection",
      run: {
        runId: "projection-run-1",
        projectionId: "rooms",
        projectionKind: "object",
      },
      failure,
    })
    if (reports[0]?.context.type !== "run.failed") throw new Error("expected a run failure")
    expect(reports[0].context.failure).toBe(failure)
  })

  test("reports delivery failures with envelope IDs only", async () => {
    const host = {}
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })

    const failure = {
      code: "event.delivery_failed" as const,
      message: "broker unavailable",
      retryable: true,
      at: "2026-01-02T03:04:05.000Z",
      details: {
        attempts: 3,
        eventTypes: ["object.updated"],
        eventIds: ["event-a", "event-b"],
      },
    }
    reportEventDeliveryFailure(host, new Error("broker unavailable"), {
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      failure,
      attempts: 3,
      eventTypes: ["object.updated"],
      eventIds: ["event-b", "event-a"],
    })
    await flushSixbErrors(host)

    expect(reports[0]?.context).toEqual({
      type: "event.delivery.failed",
      notificationId: "project:error-reporting-tests:event-delivery:events:event-a:attempt:3",
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      failure,
      attempts: 3,
      eventTypes: ["object.updated"],
      eventIds: ["event-a", "event-b"],
    })
    expect(JSON.stringify(reports[0]?.context)).not.toContain("payload")
    expect(JSON.stringify(reports[0]?.context)).not.toContain("lease")
  })

  test("two concurrent losses of the same event types are two notifications", async () => {
    const host = {}
    const reports: SixbErrorContext[] = []
    attachSixbErrorReporter(host, (_error, context) => {
      reports.push(context)
    })

    // The case that forced an identity onto this path: a broker outage during one scheduler tick loses
    // `schedule.triggered` for every due schedule at once. Nothing was persisted, so there are no
    // envelope ids; `attempts` is 1 for all of them; and the reports land in the same millisecond, which
    // is why the timestamp cannot separate them. Both are passed the *same* `occurredAt` on purpose — a
    // consumer deduplicating on `notificationId` must still see two losses.
    for (const _loss of [1, 2]) {
      reportEventDeliveryFailure(host, new Error("broker unavailable"), {
        projectId: PROJECT_ID,
        occurredAt: "2026-01-02T03:04:05.000Z",
        eventTypes: ["schedule.triggered"],
      })
    }
    await flushSixbErrors(host)

    expect(reports).toHaveLength(2)
    expect(new Set(reports.map((context) => context.notificationId)).size).toBe(2)
  })

  test("a delivery failure key is reproducible when the occurrence id is given", async () => {
    const host = {}
    const reports: SixbErrorContext[] = []
    attachSixbErrorReporter(host, (_error, context) => {
      reports.push(context)
    })

    reportEventDeliveryFailure(host, new Error("broker unavailable"), {
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      eventTypes: ["schedule.triggered"],
      occurrenceId: "loss-1",
    })
    await flushSixbErrors(host)

    expect(reports[0]?.notificationId).toBe(`project:${PROJECT_ID}:event-delivery:emit:loss-1`)
  })

  test("reports rule evaluation failures without event payloads", async () => {
    const host = {}
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })

    reportRuleEvaluationFailure(host, new Error("rule storage unavailable"), {
      projectId: PROJECT_ID,
      source: "live",
      eventIds: ["event-b", "event-a"],
      occurredAt: "2026-01-02T03:04:05.000Z",
    })
    await flushSixbErrors(host)

    expect(reports[0]?.context).toEqual({
      type: "rule.evaluation.failed",
      notificationId:
        "project:error-reporting-tests:rule-evaluation:live:event-a:failed:2026-01-02T03:04:05.000Z",
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      failure: {
        code: "internal.unexpected",
        message: "An unexpected internal error occurred.",
        retryable: false,
        at: "2026-01-02T03:04:05.000Z",
        details: { source: "live", eventIds: ["event-a", "event-b"] },
      },
      source: "live",
      eventIds: ["event-a", "event-b"],
    })
    expect(JSON.stringify(reports[0]?.context)).not.toContain("payload")
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
        runKind: "sync",
        run: { runId: "sync-run-1", syncId: "customers" },
        failure: unexpectedFailure("run failed"),
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
          runKind: "sync",
          run: { runId: "sync-run-2", syncId: "customers" },
          failure: unexpectedFailure("second"),
        })
      }
    })

    reportRunFailure(host, new Error("first"), {
      projectId: PROJECT_ID,
      runKind: "sync",
      run: { runId: "sync-run-1", syncId: "customers" },
      failure: unexpectedFailure("first"),
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
      runKind: "agent",
      run: { runId: "agent-run-1", agentId: "assistant" },
      failure: unexpectedFailure("run failed"),
    })

    await flushSixbErrors(host, 5)

    expect(consoleError).toHaveBeenCalledWith(
      "[Sixb] Timed out after 5ms waiting for 1 onError handler(s)."
    )
    consoleError.mockRestore()
  })

  test("falls back to the console when no reporter is attached", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    try {
      const host = {}
      const error = new Error("workflow failed")
      reportRunFailure(host, error, {
        projectId: PROJECT_ID,
        runKind: "workflow",
        run: { runId: "workflow-run-1", workflowId: "approval" },
        failure: unexpectedFailure("workflow failed"),
      })
      await flushSixbErrors(host)

      expect(consoleError).toHaveBeenCalledWith(
        "[Sixb] Unhandled run.failed:",
        error,
        expect.objectContaining({
          type: "run.failed",
          projectId: PROJECT_ID,
          runKind: "workflow",
          run: { runId: "workflow-run-1", workflowId: "approval" },
        })
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test("isolates the console fallback from framework execution", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {
      throw new Error("console is broken")
    })
    try {
      expect(() =>
        reportRunFailure({}, new Error("run failed"), {
          projectId: PROJECT_ID,
          runKind: "sync",
          run: { runId: "sync-run-1", syncId: "customers" },
          failure: unexpectedFailure("run failed"),
        })
      ).not.toThrow()
    } finally {
      consoleError.mockRestore()
    }
  })

  test("a rule failure is correlated by candidate, since it has no run id", async () => {
    const host = {}
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })

    reportRuleEvaluationFailure(host, new Error("predicate exploded"), {
      projectId: PROJECT_ID,
      occurredAt: OCCURRED_AT,
      source: "live",
      eventIds: ["event-1"],
      ruleId: "invoice.overdue",
      subject: { objectTypeId: "invoice", primaryId: "inv-1" },
    })
    await flushSixbErrors(host)

    // Keyed on the candidate, not the batch: two rules failing over the same events stay two
    // notifications instead of collapsing into one.
    expect(reports[0]?.context.notificationId).toBe(
      `project:${PROJECT_ID}:rule-evaluation:live:invoice.overdue:invoice:inv-1:failed:${OCCURRED_AT}`
    )
  })

  test("a rule failure with no attributable candidate falls back to the batch", async () => {
    const host = {}
    const reports: Array<{ error: Error; context: SixbErrorContext }> = []
    attachSixbErrorReporter(host, (error, context) => {
      reports.push({ error, context })
    })

    reportRuleEvaluationFailure(host, new Error("reconciliation exploded"), {
      projectId: PROJECT_ID,
      occurredAt: OCCURRED_AT,
      source: "reconciliation",
    })
    await flushSixbErrors(host)

    expect(reports[0]?.context.notificationId).toBe(
      `project:${PROJECT_ID}:rule-evaluation:reconciliation:current-state:failed:${OCCURRED_AT}`
    )
  })

  test("a failed emit is reported instead of being swallowed", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    try {
      const host = {}
      const reports: Array<{ error: Error; context: SixbErrorContext }> = []
      const reporter = attachSixbErrorReporter(host, (error, context) => {
        reports.push({ error, context })
      })
      const appendFailure = new Error("broker unavailable")
      const events = eventServiceFor(reporter)
      spyOn(events, "append").mockImplementation(() => Promise.reject(appendFailure))

      await events.emit(
        {
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "nightly", runId: "sync-run-1", status: "failed" },
            },
          ],
        },
        { source: "SixbTestWorker" }
      )
      await flushSixbErrors(host)

      expect(reports).toHaveLength(1)
      expect(reports[0]?.error).toBe(appendFailure)
      const context = reports[0]?.context
      if (context?.type !== "event.delivery.failed") throw new Error("expected a delivery failure")
      expect(context.eventTypes).toEqual(["sync.run.finished"])
      expect(context.notificationId).toStartWith(`project:${PROJECT_ID}:event-delivery:emit:`)
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  test("emit still resolves when its injected reporter throws", async () => {
    // `emit` promises never to reject, and that promise cannot depend on the escalation path working:
    // a broken adapter must not turn a run that already succeeded into a failed one. The batch is lost
    // either way — rejecting on top helps nobody.
    const events = eventServiceFor({
      report() {
        throw new Error("reporter is broken")
      },
    })
    spyOn(events, "append").mockImplementation(() =>
      Promise.reject(new Error("broker unavailable"))
    )

    await expect(
      events.emit(
        {
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "nightly", runId: "sync-run-1", status: "failed" },
            },
          ],
        },
        { source: "SixbTestWorker" }
      )
    ).resolves.toBeUndefined()
  })

  test("a failed standalone emit falls back to the console", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    try {
      const appendFailure = new Error("broker unavailable")
      const events = eventServiceFor()
      spyOn(events, "append").mockImplementation(() => Promise.reject(appendFailure))

      await events.emit(
        {
          events: [
            {
              type: "sync.run.finished",
              payload: { syncId: "nightly", runId: "sync-run-1", status: "failed" },
            },
          ],
        },
        { source: "SixbTestWorker" }
      )

      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledWith(
        "[Sixb] Unhandled event.delivery.failed:",
        appendFailure,
        expect.objectContaining({
          type: "event.delivery.failed",
          eventTypes: ["sync.run.finished"],
        })
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test("an emit that reaches the broker reports nothing", async () => {
    const reports: SixbErrorContext[] = []
    const reporter = new SixbErrorReporter((_error, context) => {
      reports.push(context)
    })
    const events = eventServiceFor(reporter)
    spyOn(events, "append").mockImplementation(() => Promise.resolve([]))

    await events.emit(
      {
        events: [
          {
            type: "sync.run.finished",
            payload: { syncId: "nightly", runId: "sync-run-1", status: "failed" },
          },
        ],
      },
      { source: "SixbTestWorker" }
    )
    await reporter.flush()

    expect(reports).toEqual([])
  })
})

// The broker is never reached: every test here spies on `append`, which is the seam `emit` wraps.
function eventServiceFor(errorReporter?: ErrorReporter): DomainEventService {
  return new DomainEventService({ projectId: PROJECT_ID, broker: {} as Broker, errorReporter })
}
