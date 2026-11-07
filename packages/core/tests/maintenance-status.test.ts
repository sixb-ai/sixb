import { describe, expect, test } from "bun:test"
import { operationalStatus } from "../src/maintenance/status"
import type { MaintenanceHeartbeatRecord } from "../src/storage"

const NOW = new Date("2026-11-07T12:00:00.000Z")

const QUIET_OUTBOX = {
  pendingCount: 0,
  oldestPendingAt: null,
  retryingCount: 0,
  maxAttempts: 0,
}

function heartbeat(
  overrides: Partial<MaintenanceHeartbeatRecord> = {}
): MaintenanceHeartbeatRecord {
  return {
    projectId: "project",
    beatAt: NOW,
    everyMs: 30_000,
    passes: [
      {
        id: "ontology",
        lastSucceededAt: new Date(NOW.getTime() - 1_000),
        consecutiveFailures: 0,
        lastError: null,
      },
    ],
    ...overrides,
  }
}

function statusOf(
  input: Partial<Omit<Parameters<typeof operationalStatus>[0], "now" | "pendingLimitMs">>
) {
  return operationalStatus({
    heartbeat: null,
    outbox: QUIET_OUTBOX,
    pendingLimitMs: 120_000,
    now: NOW,
    ...input,
  })
}

describe("operationalStatus", () => {
  test("a recent beat with every pass healthy is ok, dates as text", () => {
    expect(statusOf({ heartbeat: heartbeat() })).toEqual({
      status: "ok",
      maintenance: {
        beatAt: NOW.toISOString(),
        stale: false,
        passes: [
          {
            id: "ontology",
            lastSucceededAt: "2026-11-07T11:59:59.000Z",
            consecutiveFailures: 0,
            lastError: null,
          },
        ],
        outbox: QUIET_OUTBOX,
      },
    })
  })

  test("says so when no loop ever beat, rather than claiming ok", () => {
    expect(statusOf({ heartbeat: null })).toMatchObject({
      status: "unknown",
      maintenance: { beatAt: null, stale: false, passes: [] },
    })
  })

  test.each([
    { ageMs: 60_000, status: "ok", stale: false },
    { ageMs: 60_001, status: "degraded", stale: true },
  ])("a beat $ageMs ms old is $status", ({ ageMs, status, stale }) => {
    const beatAt = new Date(NOW.getTime() - ageMs)

    expect(statusOf({ heartbeat: heartbeat({ beatAt }) })).toMatchObject({
      status,
      maintenance: { stale },
    })
  })

  test("reads staleness from the interval the loop wrote", () => {
    const beatAt = new Date(NOW.getTime() - 100_000)

    expect(statusOf({ heartbeat: heartbeat({ beatAt, everyMs: 60_000 }) }).status).toBe("ok")
  })

  test.each([
    { failures: 1, status: "ok" },
    { failures: 2, status: "degraded" },
  ])("a pass that failed $failures time(s) in a row is $status", ({ failures, status }) => {
    const passes = [
      { id: "cron", lastSucceededAt: null, consecutiveFailures: failures, lastError: "Error: x" },
    ]

    expect(statusOf({ heartbeat: heartbeat({ passes }) }).status).toBe(status)
  })

  test("events stuck in the outbox are degraded even with no loop to blame", () => {
    const repeating = { ...QUIET_OUTBOX, pendingCount: 1, maxAttempts: 3 }
    const waiting = {
      ...QUIET_OUTBOX,
      pendingCount: 1,
      oldestPendingAt: new Date(NOW.getTime() - 120_001).toISOString(),
    }
    const justSaved = { ...waiting, oldestPendingAt: NOW.toISOString() }

    expect(statusOf({ outbox: repeating }).status).toBe("degraded")
    expect(statusOf({ outbox: waiting }).status).toBe("degraded")
    expect(statusOf({ outbox: justSaved }).status).toBe("unknown")
  })
})
