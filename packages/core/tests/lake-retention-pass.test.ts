import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  InMemoryLakeStorage,
  type LakeMaintenanceOptions,
  prop,
  SixbHost,
} from "../src"
import type { LakeMaintenance } from "../src/lake-storage"
import type { LakeRetentionState } from "../src/maintenance/lake-retention-status"
import { MaintenanceLoop } from "../src/maintenance/loop"
import { lakeRetentionPass } from "../src/maintenance/passes/lake-retention-pass"
import { InMemoryQueues } from "../src/queues"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const projectId = "project"

/** Nine minutes past an hour, so a first request and an interval's start are told apart. */
const STARTED_AT = new Date("2026-11-05T10:09:00.000Z")

/** A lake lane, and what a worker would find on it: reading a request consumes it. */
function lanes(queues = new InMemoryQueues()) {
  return {
    queues,
    async requested(): Promise<readonly string[]> {
      const claimed = await queues.lake.claim({ projectId, workerId: "test", limit: 100 })

      for (const { job, leaseId } of claimed) {
        await queues.lake.complete({ projectId, jobId: job.id, leaseId })
      }

      return claimed.map(({ job }) => job.payload.intervalStart)
    },
  }
}

function startLoop(
  queue: Pick<InMemoryQueues["lake"], "enqueue">,
  failures: unknown[] = [],
  state: LakeRetentionState = "ok"
) {
  const loop = new MaintenanceLoop({
    passes: [
      lakeRetentionPass({
        projectId,
        cleanupEveryMs: HOUR,
        queue,
        status: async () => ({ state }),
      }),
    ],
    onError: (error) => failures.push(error),
  })
  loop.start()

  return loop
}

/** Lets a request the timer started reach the queue. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms)
  await settle()
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(STARTED_AT)
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe("the lake-retention pass", () => {
  test("requests the current interval as soon as it starts, under the interval's id", async () => {
    const { queues } = lanes()
    const loop = startLoop(queues.lake)
    await settle()

    const [claimed] = await queues.lake.claim({ projectId, workerId: "test" })

    expect(claimed?.job).toMatchObject({
      id: "lake-retention:2026-11-05T10:00:00.000Z",
      type: "lake.retention.requested",
      payload: { intervalStart: "2026-11-05T10:00:00.000Z" },
    })
    await loop.stop()
  })

  // Reproduce: return `lastFinishedAt + cleanupEveryMs` from nextRunAt in lake-retention-pass.ts.
  test("then requests each interval as it starts, not one interval after the last request", async () => {
    const { queues, requested } = lanes()
    const loop = startLoop(queues.lake)
    await settle()
    await requested()

    await advance(51 * MINUTE - 1)
    expect(await requested()).toEqual([])

    await advance(1)
    expect(await requested()).toEqual(["2026-11-05T11:00:00.000Z"])

    await advance(HOUR)
    expect(await requested()).toEqual(["2026-11-05T12:00:00.000Z"])

    await loop.stop()
  })

  // Reproduce: put a random suffix on the job id in lake-retention-pass.ts.
  test("requests nothing more when it restarts within an interval", async () => {
    const { queues, requested } = lanes()

    const first = startLoop(queues.lake)
    await settle()
    await first.stop()

    jest.setSystemTime(STARTED_AT.getTime() + 20 * MINUTE)
    const second = startLoop(queues.lake)
    await settle()
    await second.stop()

    expect(await requested()).toEqual(["2026-11-05T10:00:00.000Z"])
  })

  // Reproduce: set `requested` before the enqueue in lake-retention-pass.ts; the next try then
  // waits for the next interval.
  test("tries a failed request again a minute later, not an interval later", async () => {
    const { queues, requested } = lanes()
    const failures: unknown[] = []
    let refuse = true
    const queue = {
      enqueue: async (input: Parameters<typeof queues.lake.enqueue>[0]) => {
        if (refuse) throw new Error("the queue is unreachable")
        return queues.lake.enqueue(input)
      },
    }

    const loop = startLoop(queue, failures)
    await settle()
    expect(failures).toHaveLength(1)

    await advance(MINUTE - 1)
    expect(failures).toHaveLength(1)

    await advance(1)
    expect(failures).toHaveLength(2)

    refuse = false
    await advance(MINUTE)
    expect(await requested()).toEqual(["2026-11-05T10:00:00.000Z"])

    await loop.stop()
  })

  // Reproduce: drop the `requested` check from nextRunAt in lake-retention-pass.ts; the pass then
  // comes due again a minute after each request.
  test("asks for nothing else within the interval", async () => {
    const { queues, requested } = lanes()
    const enqueue = queues.lake.enqueue.bind(queues.lake)
    let requests = 0
    const queue = {
      enqueue: async (input: Parameters<typeof enqueue>[0]) => {
        requests += 1
        return enqueue(input)
      },
    }

    const loop = startLoop(queue)
    await settle()
    await advance(30 * MINUTE)

    expect(requests).toBe(1)
    expect(await requested()).toEqual(["2026-11-05T10:00:00.000Z"])

    await loop.stop()
  })
})

describe("a request nobody answers", () => {
  // Separate `sixb worker <type>` processes leave no one able to tell at startup. Reproduce: drop
  // the `status` check from run in lake-retention-pass.ts.
  test("says so in the orchestrator's output", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const { queues } = lanes()

    const loop = startLoop(queues.lake, [], "no-worker")
    await settle()
    await loop.stop()

    expect(String(warn.mock.calls[0])).toContain("no lake worker has run it")
  })

  test("says nothing when a worker answers", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const { queues, requested } = lanes()

    const loop = startLoop(queues.lake)
    await settle()
    await loop.stop()

    // The pass got as far as the status: the request is out, so this silence can be trusted.
    expect(await requested()).toEqual(["2026-11-05T10:00:00.000Z"])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("SixbHost.startMaintenance", () => {
  const Stub = defineObjectType({
    id: "Stub",
    name: "Stub",
    properties: [prop("id", "string", { required: true, primary: true })],
  })

  const rooms = defineDataset("raw.rooms", { schema: [col("id", "string")] })

  class MaintainedLakeStorage extends InMemoryLakeStorage {
    readonly maintenance: LakeMaintenance = {
      applyRetention: async () => {
        throw new Error("the loop only requests retention")
      },
      describeStorage: async () => [],
    }
  }

  function host(lakeMaintenance: LakeMaintenanceOptions) {
    return new SixbHost({
      id: projectId,
      ontology: [Stub],
      datasets: [rooms],
      ...createTestRuntimeDeps(),
      lakeStorage: new MaintainedLakeStorage(),
      lakeMaintenance,
    })
  }

  async function runMaintenance(sixb: SixbHost): Promise<readonly string[] | undefined> {
    const maintenance = sixb.startMaintenance([])
    await settle()
    await maintenance.stop()

    const heartbeats = await sixb.storage.maintenanceHeartbeats?.list({ projectId })
    return heartbeats?.flatMap((heartbeat) => heartbeat.passes.map((pass) => pass.id))
  }

  // Reproduce: drop `lakeRetentionPasses()` from `SixbHost.startMaintenance`.
  test("requests lake retention beside the project's other upkeep", async () => {
    const sixb = host({})

    expect(await runMaintenance(sixb)).toContain("lake-retention")
    expect(await lanes(sixb.queues as InMemoryQueues).requested()).toEqual([
      "2026-11-05T10:00:00.000Z",
    ])
  })

  // The heartbeat lists every pass the loop runs, so this cannot pass for want of time.
  test("requests none when it is turned off", async () => {
    const sixb = host({ enabled: false })

    const passes = await runMaintenance(sixb)

    expect(passes).toContain("cron")
    expect(passes).not.toContain("lake-retention")
  })
})
