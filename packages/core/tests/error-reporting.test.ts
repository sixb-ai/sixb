import { describe, expect, spyOn, test } from "bun:test"
import { SIXB_BACKGROUND_TASKS, type SixbErrorContext, type SixbFailure } from "../src"
import type { Broker } from "../src/broker"
import {
  attachSixbErrorReporter,
  flushSixbErrors,
  reportBackgroundTaskFailure,
  reportEventDeliveryFailure,
  reportRuleEvaluationFailure,
  reportRunFailure,
} from "../src/error-reporting/internal"
import { SixbError } from "../src/errors"
import { EventsRuntime } from "../src/events"

/** What `onError` is handed: the portable record, and the live thrown value on the context. */
type Report = { failure: SixbFailure; context: SixbErrorContext & { cause: unknown } }

const PROJECT_ID = "error-reporting-tests"
const OCCURRED_AT = "2026-07-29T12:00:00.000Z"

describe("Sixb error reporting", () => {
  test("reports a normalized terminal run failure with stable context", async () => {
    const host = {}
    const reports: Report[] = []
    attachSixbErrorReporter(host, (failure, context) => {
      reports.push({ failure, context })
    })

    // The record the run row was given. `cause` is a bare string, so a reporter deriving the record
    // itself could only have said `runtime.unexpected` with no `details` — which is exactly what this
    // channel used to hand a handler while the row said something else.
    const stored = {
      code: "projection.failed",
      message: "projection exploded",
      details: { phase: "replace" },
    } as const
    reportRunFailure(host, "projection exploded", {
      projectId: PROJECT_ID,
      failure: stored,
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
    expect(reports[0]?.failure).toEqual(stored)
    expect(reports[0]?.context).toEqual({
      cause: "projection exploded",
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

  test("reports delivery failures with envelope IDs only", async () => {
    const host = {}
    const reports: Report[] = []
    attachSixbErrorReporter(host, (failure, context) => {
      reports.push({ failure, context })
    })

    reportEventDeliveryFailure(host, new Error("broker unavailable"), {
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      attempts: 3,
      eventTypes: ["object.updated"],
      eventIds: ["event-b", "event-a"],
    })
    await flushSixbErrors(host)

    expect(reports[0]?.context).toEqual({
      cause: expect.any(Error),
      type: "event.delivery.failed",
      notificationId: "project:error-reporting-tests:event-delivery:events:event-a:attempt:3",
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      attempts: 3,
      eventTypes: ["object.updated"],
      eventIds: ["event-a", "event-b"],
    })
    expect(JSON.stringify(reports[0]?.context)).not.toContain("payload")
    expect(JSON.stringify(reports[0]?.context)).not.toContain("lease")
  })

  test("two concurrent losses of the same event types are two notifications", async () => {
    const host = {}
    const reports: Array<Report["context"]> = []
    attachSixbErrorReporter(host, (_failure, context) => {
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
    const reports: Array<Report["context"]> = []
    attachSixbErrorReporter(host, (_failure, context) => {
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
    const reports: Report[] = []
    attachSixbErrorReporter(host, (failure, context) => {
      reports.push({ failure, context })
    })

    reportRuleEvaluationFailure(host, new Error("rule storage unavailable"), {
      projectId: PROJECT_ID,
      source: "live",
      eventIds: ["event-b", "event-a"],
      occurredAt: "2026-01-02T03:04:05.000Z",
    })
    await flushSixbErrors(host)

    expect(reports[0]?.context).toEqual({
      cause: expect.any(Error),
      type: "rule.evaluation.failed",
      notificationId:
        "project:error-reporting-tests:rule-evaluation:live:event-a:failed:2026-01-02T03:04:05.000Z",
      projectId: PROJECT_ID,
      occurredAt: "2026-01-02T03:04:05.000Z",
      source: "live",
      eventIds: ["event-a", "event-b"],
    })
    expect(JSON.stringify(reports[0]?.context)).not.toContain("payload")
  })

  test("a runtime with no handler prints every failure it reports", async () => {
    // The guard: remove the default in `SixbErrorReporter` (back to `if (!this.handler) return`) and
    // this fails. It is the difference between an unconfigured project seeing its dispatcher die and
    // seeing nothing at all, which is what the whole channel exists to fix.
    const host = {}
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    try {
      attachSixbErrorReporter(host)
      const cause = new Error("could not reach the store")

      reportBackgroundTaskFailure(host, cause, {
        projectId: PROJECT_ID,
        task: "ontology.outbox",
      })
      await flushSixbErrors(host)

      expect(consoleError).toHaveBeenCalledWith(
        "[Sixb] background task 'ontology.outbox' failed — runtime.unexpected: could not reach the store",
        cause
      )
    } finally {
      consoleError.mockRestore()
    }
  })

  test("a configured handler replaces the printer rather than adding to it", async () => {
    const host = {}
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    try {
      attachSixbErrorReporter(host, () => {})
      reportBackgroundTaskFailure(host, new Error("boom"), {
        projectId: PROJECT_ID,
        task: "queue.lease",
      })
      await flushSixbErrors(host)

      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  test("a background task failure carries the task and what it was working on", async () => {
    const host = {}
    const reports: Report[] = []
    attachSixbErrorReporter(host, (failure, context) => {
      reports.push({ failure, context })
    })

    reportBackgroundTaskFailure(host, new SixbError("queue.unavailable", "queue is down"), {
      projectId: PROJECT_ID,
      task: "agent.dispatch",
      subject: "agent-run-1",
      occurredAt: OCCURRED_AT,
    })
    await flushSixbErrors(host)

    expect(reports[0]?.failure.code).toBe("queue.unavailable")
    expect(reports[0]?.context).toEqual({
      cause: expect.any(SixbError),
      type: "background.task.failed",
      notificationId: `project:${PROJECT_ID}:background:agent.dispatch:agent-run-1:failed:${OCCURRED_AT}`,
      projectId: PROJECT_ID,
      occurredAt: OCCURRED_AT,
      task: "agent.dispatch",
      subject: "agent-run-1",
    })
  })

  test("every background task is a distinct notification for the same moment", async () => {
    // Two loops failing in the same broker outage land in the same millisecond. Collapsing them into
    // one notification would hide the second outage behind the first.
    const host = {}
    const reports: Array<Report["context"]> = []
    attachSixbErrorReporter(host, (_failure, context) => {
      reports.push(context)
    })

    for (const task of SIXB_BACKGROUND_TASKS) {
      reportBackgroundTaskFailure(host, new Error("broker unavailable"), {
        projectId: PROJECT_ID,
        task,
        occurredAt: OCCURRED_AT,
      })
    }
    await flushSixbErrors(host)

    expect(new Set(reports.map((context) => context.notificationId)).size).toBe(
      SIXB_BACKGROUND_TASKS.length
    )
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
        failure: { code: "sync.failed", message: "run failed" },
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
    attachSixbErrorReporter(host, (failure) => {
      messages.push(failure.message)
      if (failure.message === "first") {
        reportRunFailure(host, new Error("second"), {
          projectId: PROJECT_ID,
          failure: { code: "sync.failed", message: "second" },
          run: { kind: "sync", runId: "sync-run-2", syncId: "customers" },
        })
      }
    })

    reportRunFailure(host, new Error("first"), {
      projectId: PROJECT_ID,
      failure: { code: "sync.failed", message: "first" },
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
      failure: { code: "agent.failed", message: "run failed" },
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
      failure: { code: "workflow.failed", message: "ignored" },
      run: { kind: "workflow", runId: "workflow-run-1", workflowId: "approval" },
    })
    await expect(flushSixbErrors(host)).resolves.toBeUndefined()
  })

  test("a rule failure is correlated by candidate, since it has no run id", async () => {
    const host = {}
    const reports: Report[] = []
    attachSixbErrorReporter(host, (failure, context) => {
      reports.push({ failure, context })
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
    const reports: Report[] = []
    attachSixbErrorReporter(host, (failure, context) => {
      reports.push({ failure, context })
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
      const reports: Report[] = []
      attachSixbErrorReporter(host, (failure, context) => {
        reports.push({ failure, context })
      })
      const appendFailure = new Error("broker unavailable")
      const events = eventsRuntimeFor(host)
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
      // The thrown value reaches the handler alive, stack included, beside the portable record.
      expect(reports[0]?.context.cause).toBe(appendFailure)
      const context = reports[0]?.context
      if (context?.type !== "event.delivery.failed") throw new Error("expected a delivery failure")
      expect(context.eventTypes).toEqual(["sync.run.finished"])
      expect(context.source).toBe("SixbTestWorker")
      expect(context.notificationId).toStartWith(`project:${PROJECT_ID}:event-delivery:emit:`)
      // The emit site prints nothing of its own: a handler is configured, so the escalation is the
      // only trace, which is the whole point of there being one channel.
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  test("emit still resolves when escalation itself throws", async () => {
    // `emit` promises never to reject, and that promise cannot depend on the escalation path working:
    // an app that replaced `console` with something that throws would otherwise turn a run that had
    // already succeeded into a failed one. The batch is lost either way — rejecting on top helps nobody.
    const consoleError = spyOn(console, "error").mockImplementation(() => {
      throw new Error("console is broken")
    })
    try {
      const host = {}
      const events = eventsRuntimeFor(host)
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
    } finally {
      consoleError.mockRestore()
    }
  })

  test("an emit that reaches the broker reports nothing", async () => {
    const host = {}
    const reports: Array<Report["context"]> = []
    attachSixbErrorReporter(host, (_failure, context) => {
      reports.push(context)
    })
    const events = eventsRuntimeFor(host)
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
    await flushSixbErrors(host)

    expect(reports).toEqual([])
  })
})

// The broker is never reached: every test here spies on `append`, which is the seam `emit` wraps.
function eventsRuntimeFor(host: object): EventsRuntime {
  return new EventsRuntime({ projectId: PROJECT_ID, broker: {} as Broker, host })
}
