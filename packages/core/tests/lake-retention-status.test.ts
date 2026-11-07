import { describe, expect, test } from "bun:test"
import { lakeRetentionStatus } from "../src/maintenance/lake-retention-status"
import type { LakeRetentionRunRecord, MaintenanceHeartbeatRecord } from "../src/storage"

const HOUR = 60 * 60_000
const NOW = new Date("2026-11-05T12:30:00.000Z")
const projectId = "project"

const REQUESTED_AT = new Date("2026-11-05T12:00:00.000Z")
const settings = { enabled: true, cleanupEveryMs: HOUR }

function heartbeat(
  pass: Partial<MaintenanceHeartbeatRecord["passes"][number]> | null = {},
  beatAt = NOW
): MaintenanceHeartbeatRecord {
  return {
    projectId,
    beatAt,
    everyMs: 30_000,
    passes: pass
      ? [
          {
            id: "lake-retention",
            lastSucceededAt: REQUESTED_AT,
            consecutiveFailures: 0,
            ...pass,
          },
        ]
      : [],
  }
}

function run(startedAt: string, failed = false): LakeRetentionRunRecord {
  const started = new Date(startedAt)
  return { projectId, startedAt: started, finishedAt: new Date(started.getTime() + 5_000), failed }
}

const ranThisInterval = run("2026-11-05T12:00:05.000Z")

function status(input: Partial<Parameters<typeof lakeRetentionStatus>[0]>) {
  return lakeRetentionStatus({
    settings,
    automatic: true,
    heartbeat: heartbeat(),
    lastRun: ranThisInterval,
    now: NOW,
    ...input,
  })
}

describe("lake retention status", () => {
  test("is ok when requests go out and a worker runs them", () => {
    expect(status({})).toEqual({
      state: "ok",
      lastRequestedAt: "2026-11-05T12:00:00.000Z",
      lastRunAt: "2026-11-05T12:00:05.000Z",
    })
  })

  // Settings alone used to say this. Reproduce: answer "ok" for
  // every project with `automatic` in lake-retention-status.ts.
  test("says nothing asks when no orchestrator ever beat", () => {
    expect(status({ heartbeat: null }).state).toBe("not-requested")
  })

  test("says nothing asks when the orchestrator stopped beating", () => {
    const stopped = heartbeat({}, new Date(NOW.getTime() - 60_001))

    expect(status({ heartbeat: stopped }).state).toBe("not-requested")
  })

  test("says nothing asks when the loop runs without this pass", () => {
    expect(status({ heartbeat: heartbeat(null) }).state).toBe("not-requested")
  })

  test("says nothing asks before the pass's first request", () => {
    expect(status({ heartbeat: heartbeat({ lastSucceededAt: null }) }).state).toBe("not-requested")
  })

  test("says no worker runs requests when none ever finished one", () => {
    expect(status({ lastRun: null }).state).toBe("no-worker")
  })

  // Reproduce: compare `lastRun.startedAt` with `now` in lake-retention-status.ts; a weekly
  // interval then flags no worker for days.
  test("says no worker runs requests once one whole interval went unanswered", () => {
    expect(status({ lastRun: run("2026-11-05T10:59:59.999Z") }).state).toBe("no-worker")
    expect(status({ lastRun: run("2026-11-05T11:00:00.000Z") }).state).toBe("ok")
  })

  // A request is always newer than the run answering it, for a moment: that is no warning.
  test("stays ok between a new request and the run that answers it", () => {
    expect(status({ lastRun: run("2026-11-05T11:00:05.000Z") }).state).toBe("ok")
  })

  // A first run lasts up to ten minutes, and it is when an operator looks. Reproduce: return
  // "no-worker" for `lastRun.finishedAt === null` in lake-retention-status.ts.
  test("says a run is under way, not that no worker exists", () => {
    const started = { projectId, startedAt: REQUESTED_AT, finishedAt: null, failed: false }

    expect(status({ lastRun: started })).toMatchObject({
      state: "cleaning",
      lastRunAt: "2026-11-05T12:00:00.000Z",
    })
  })

  // A worker that died mid-run left a row with no end. Reproduce: test `finishedAt` before
  // `isBehind` in lake-retention-status.ts.
  test("stops saying so once a run outlives its interval and the next request goes unanswered", () => {
    const abandoned = {
      projectId,
      startedAt: new Date("2026-11-05T10:00:00.000Z"),
      finishedAt: null,
      failed: false,
    }

    expect(status({ lastRun: abandoned }).state).toBe("no-worker")
  })

  test("is failing when the last run failed", () => {
    expect(status({ lastRun: run("2026-11-05T12:00:05.000Z", true) }).state).toBe("failing")
  })

  test("is failing when requests fail", () => {
    const failing = heartbeat({ consecutiveFailures: 1 })

    expect(status({ heartbeat: failing }).state).toBe("failing")
  })

  // Reproduce: test `lastRun?.failed` before `isBehind` in lake-retention-status.ts.
  test("names the missing worker over an old failure", () => {
    expect(status({ lastRun: run("2026-11-05T09:00:05.000Z", true) }).state).toBe("no-worker")
  })

  test("is off when the project turned it off, whatever ran before", () => {
    const off = { ...settings, enabled: false }

    expect(status({ settings: off, automatic: false }).state).toBe("off")
  })

  test("has nothing to do without datasets", () => {
    expect(status({ automatic: false, heartbeat: null }).state).toBe("idle")
  })
})
