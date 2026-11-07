import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import {
  everyMs,
  type MaintenanceFailure,
  type MaintenanceHeartbeat,
  MaintenanceLoop,
  type MaintenanceLoopOptions,
  type MaintenancePass,
} from "../src/maintenance"

const START = new Date("2026-11-07T12:00:00.000Z")
const SECOND = 1_000

type HeartbeatWrite = Parameters<MaintenanceHeartbeat["write"]>[0]

/** Advances the faked clock and lets what the timers started run its continuations. */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms)
  await flush()
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function intervalPass(id: string, run: MaintenancePass["run"], intervalMs = 10 * SECOND) {
  return everyMs({ id, intervalMs, budgetMs: 60 * SECOND, run })
}

/** A pass that counts its runs and does nothing. */
function countingPass(id: string, intervalMs = 10 * SECOND) {
  const counted = {
    runs: 0,
    pass: intervalPass(
      id,
      async () => {
        counted.runs += 1
      },
      intervalMs
    ),
  }
  return counted
}

describe("MaintenanceLoop", () => {
  const failures: { error: unknown; failure: MaintenanceFailure }[] = []
  const loops: MaintenanceLoop[] = []

  function startLoop(
    passes: readonly MaintenancePass[],
    options: Partial<MaintenanceLoopOptions> = {}
  ): MaintenanceLoop {
    const loop = new MaintenanceLoop({
      passes,
      onError: (error, failure) => failures.push({ error, failure }),
      ...options,
    })
    loops.push(loop)
    loop.start()
    return loop
  }

  beforeEach(() => {
    failures.length = 0
    jest.useFakeTimers({ now: START })
  })

  afterEach(async () => {
    jest.useRealTimers()
    for (const loop of loops.splice(0)) await loop.stop()
  })

  test("an interval pass runs at start, then that long after each run ends", async () => {
    const release = deferred()
    let runs = 0
    startLoop([
      intervalPass("slow", async () => {
        runs += 1
        if (runs === 1) await release.promise
      }),
    ])
    expect(runs).toBe(1)

    await advance(30 * SECOND)
    release.resolve()
    await flush()
    expect(runs).toBe(1)

    await advance(10 * SECOND - 1)
    expect(runs).toBe(1)

    await advance(1)
    expect(runs).toBe(2)
  })

  test("runs every pass on one timer", async () => {
    const quick = countingPass("quick", 2 * SECOND)
    const slow = countingPass("slow", 5 * SECOND)
    startLoop([quick.pass, slow.pass])
    await flush()

    expect(jest.getTimerCount()).toBe(1)

    await advance(10 * SECOND)
    await advance(0)

    expect(jest.getTimerCount()).toBe(1)
    expect(quick.runs).toBeGreaterThan(slow.runs)
    expect(slow.runs).toBeGreaterThan(1)
  })

  // Reproduce: start no run in `tick` while another is in flight; the quick pass stops at one run.
  test("a pass that hangs never holds another", async () => {
    const release = deferred()
    const quick = countingPass("quick", SECOND)
    startLoop([intervalPass("hung", () => release.promise), quick.pass])
    await flush()

    for (let tick = 0; tick < 5; tick++) await advance(SECOND)

    expect(quick.runs).toBe(6)
    release.resolve()
  })

  // Reproduce: drop the `state.run` check from `tick`; a second run starts beside the first.
  test("never runs a pass twice at once", async () => {
    const release = deferred()
    let running = 0
    let mostRunning = 0
    const pass: MaintenancePass = {
      id: "always-due",
      budgetMs: 60 * SECOND,
      nextRunAt: (now) => now,
      async run() {
        running += 1
        mostRunning = Math.max(mostRunning, running)
        await release.promise
        running -= 1
      },
    }
    startLoop([pass, countingPass("wakes-the-loop", SECOND).pass])
    await flush()

    for (let tick = 0; tick < 3; tick++) await advance(SECOND)

    expect(mostRunning).toBe(1)
    release.resolve()
  })

  test("counts and reports each pass's failures on its own", async () => {
    let failing = true
    const beats: HeartbeatWrite[] = []
    const healthy = countingPass("healthy", SECOND)
    const flaky = intervalPass(
      "flaky",
      async () => {
        if (failing) throw new Error("catalog unavailable")
      },
      SECOND
    )

    startLoop([flaky, healthy.pass], {
      heartbeat: { write: async (beat) => void beats.push(beat) },
    })
    await flush()
    await advance(SECOND)

    expect(failures.map(({ failure }) => failure)).toEqual([
      { passId: "flaky", consecutiveFailures: 1 },
      { passId: "flaky", consecutiveFailures: 2 },
    ])
    expect(beats.at(-1)?.passes).toEqual([
      {
        id: "flaky",
        lastSucceededAt: null,
        consecutiveFailures: 2,
      },
      expect.objectContaining({ id: "healthy", consecutiveFailures: 0 }),
    ])

    failing = false
    await advance(SECOND)

    expect(beats.at(-1)?.passes[0]).toMatchObject({
      id: "flaky",
      consecutiveFailures: 0,
    })
    expect(beats.at(-1)?.passes[0]?.lastSucceededAt).toBeInstanceOf(Date)
  })

  // Reproduce: assign `state.run` after `execute` returns; the run that threw at once stays in the
  // slot and the pass never runs again.
  test("a pass that throws before its first await runs again", async () => {
    let runs = 0
    const pass: MaintenancePass = {
      id: "throws-at-once",
      budgetMs: 60 * SECOND,
      nextRunAt: (now, lastFinishedAt) =>
        lastFinishedAt ? new Date(lastFinishedAt.getTime() + SECOND) : now,
      run() {
        runs += 1
        throw new Error("no promise at all")
      },
    }
    startLoop([pass])
    await flush()

    await advance(SECOND)

    expect(runs).toBe(2)
  })

  test("a pass that cannot say when it is due fails alone", async () => {
    const healthy = countingPass("healthy", SECOND)
    const broken: MaintenancePass = {
      id: "broken",
      budgetMs: 60 * SECOND,
      nextRunAt() {
        throw new Error("bad expression")
      },
      run: async () => {},
    }
    startLoop([broken, healthy.pass])
    await flush()

    await advance(SECOND)

    expect(healthy.runs).toBe(2)
    expect(failures.at(-1)?.failure.passId).toBe("broken")
  })

  test("a run past its budget is told to stop, counts as failed, and keeps its slot", async () => {
    const release = deferred()
    let signal: AbortSignal | undefined
    let runs = 0
    const pass = everyMs({
      id: "overrun",
      intervalMs: SECOND,
      budgetMs: 5 * SECOND,
      run(runSignal) {
        signal = runSignal
        runs += 1
        return release.promise
      },
    })
    startLoop([pass])
    await flush()

    await advance(5 * SECOND - 1)
    expect(signal?.aborted).toBe(false)
    expect(failures).toEqual([])

    await advance(1)
    expect(signal?.aborted).toBe(true)
    expect(failures.map(({ failure }) => failure)).toEqual([
      { passId: "overrun", consecutiveFailures: 1 },
    ])

    // Still running: each further budget counts, and no second run starts beside it.
    await advance(5 * SECOND)
    expect(failures).toHaveLength(2)
    expect(runs).toBe(1)

    release.resolve()
  })

  test("a run that stops on its budget counts once, then the pass runs again", async () => {
    let runs = 0
    const pass = everyMs({
      id: "stops",
      intervalMs: SECOND,
      budgetMs: 5 * SECOND,
      run: (signal) =>
        new Promise((_resolve, reject) => {
          runs += 1
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    })
    startLoop([pass])
    await flush()

    await advance(5 * SECOND)

    expect(failures).toHaveLength(1)
    expect(runs).toBe(1)

    await advance(SECOND)
    expect(runs).toBe(2)
  })

  test("fires a dated pass on its exact millisecond", async () => {
    const dueAt = new Date(START.getTime() + 90 * SECOND + 250)
    let firedAt: number | undefined
    let fired = false
    const pass: MaintenancePass = {
      id: "dated",
      budgetMs: 60 * SECOND,
      nextRunAt: () => (fired ? null : dueAt),
      async run() {
        fired = true
        firedAt = Date.now()
      },
    }
    startLoop([pass, countingPass("beside-it", 7 * SECOND).pass])
    await flush()

    for (let elapsed = 0; elapsed < 91 * SECOND; elapsed += 500) await advance(500)

    expect(firedAt).toBe(dueAt.getTime())
  })

  // Reproduce: remove `MAX_TIMER_DELAY_MS` from `arm`; the overflowing delay fires at once and the
  // timer spins until the pass is in range.
  test("clamps a delay past the timer's limit, and wakes in time for what is far away", async () => {
    let runs = 0
    const monthAway = new Date(START.getTime() + 30 * 24 * 3_600 * SECOND)
    const pass: MaintenancePass = {
      id: "far",
      budgetMs: 60 * SECOND,
      nextRunAt: () => (runs === 0 ? monthAway : null),
      async run() {
        runs += 1
      },
    }
    startLoop([pass])
    await flush()

    await advance(2_147_483_647)
    expect(runs).toBe(0)

    await advance(monthAway.getTime() - START.getTime() - 2_147_483_647)
    expect(runs).toBe(1)
  })

  test("asks a pass with nothing to do again at the next wake", async () => {
    let dueAt: Date | null = null
    let runs = 0
    const pass: MaintenancePass = {
      id: "idle",
      budgetMs: 60 * SECOND,
      nextRunAt: () => dueAt,
      async run() {
        runs += 1
        dueAt = null
      },
    }
    startLoop([pass, countingPass("wakes-the-loop", SECOND).pass])
    await flush()

    await advance(SECOND)
    expect(runs).toBe(0)

    dueAt = new Date(Date.now())
    await advance(SECOND)
    expect(runs).toBe(1)
  })

  describe("heartbeat", () => {
    test("beats at start, as each run ends, and on its own when nothing runs", async () => {
      const beats: HeartbeatWrite[] = []
      startLoop([countingPass("rare", 3_600 * SECOND).pass], {
        heartbeat: { everyMs: 30 * SECOND, write: async (beat) => void beats.push(beat) },
      })
      await flush()

      expect(beats.map((beat) => beat.beatAt)).toEqual([START, START])
      expect(beats[1]?.passes[0]?.lastSucceededAt).toEqual(START)

      await advance(30 * SECOND - 1)
      expect(beats).toHaveLength(2)

      await advance(1)
      expect(beats).toHaveLength(3)
      expect(beats[2]?.everyMs).toBe(30 * SECOND)
    })

    // Reproduce: await `this.beating` in `execute` before arming; the hung write stops every pass.
    test("a hung write costs the passes nothing, and leaves the beat stale", async () => {
      const release = deferred()
      let writes = 0
      const quick = countingPass("quick", SECOND)
      startLoop([quick.pass], {
        heartbeat: {
          write() {
            writes += 1
            return release.promise
          },
        },
      })
      await flush()

      for (let tick = 0; tick < 3; tick++) await advance(SECOND)

      expect(quick.runs).toBe(4)
      expect(writes).toBe(1)
      release.resolve()
    })

    test("a failed write is reported, and the next beat tries again", async () => {
      let writes = 0
      startLoop([], {
        heartbeat: {
          everyMs: 30 * SECOND,
          async write() {
            writes += 1
            if (writes === 1) throw new Error("storage down")
          },
        },
      })
      await flush()

      expect(failures.map(({ failure }) => failure.passId)).toEqual(["heartbeat"])

      await advance(30 * SECOND)
      expect(writes).toBe(2)
      expect(failures).toHaveLength(1)
    })
  })

  describe("stop", () => {
    test("aborts running passes, waits for them, and arms nothing more", async () => {
      const quick = countingPass("quick", SECOND)
      let ended = false
      const pass = intervalPass(
        "running",
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                setTimeout(() => {
                  ended = true
                  reject(signal.reason)
                }, SECOND)
              },
              { once: true }
            )
          })
      )
      const loop = startLoop([pass, quick.pass])
      await flush()

      const stopping = loop.stop()
      await advance(SECOND - 1)
      expect(ended).toBe(false)

      await advance(1)
      await stopping

      expect(failures).toEqual([])
      expect(jest.getTimerCount()).toBe(0)

      const runs = quick.runs
      await advance(10 * SECOND)
      expect(quick.runs).toBe(runs)
    })

    test("reports a pass that outlives the shutdown grace, and keeps waiting for it", async () => {
      const release = deferred()
      const loop = startLoop([intervalPass("stubborn", () => release.promise)], {
        shutdownTimeoutMs: 5 * SECOND,
      })
      await flush()

      let stopped = false
      const stopping = loop.stop().then(() => {
        stopped = true
      })
      await advance(5 * SECOND)

      expect(failures[0]?.failure.passId).toBe("stubborn")
      expect(stopped).toBe(false)

      release.resolve()
      await stopping
      expect(stopped).toBe(true)
    })

    test("a later start runs every pass again at once", async () => {
      const quick = countingPass("quick", 60 * SECOND)
      const loop = startLoop([quick.pass])
      await flush()
      await loop.stop()

      loop.start()
      await flush()

      expect(quick.runs).toBe(2)
    })
  })

  describe("runNow", () => {
    test("runs one pass and resolves once it ended and that was written", async () => {
      const beats: HeartbeatWrite[] = []
      const chosen = countingPass("chosen")
      const other = countingPass("other")
      const loop = new MaintenanceLoop({
        passes: [chosen.pass, other.pass],
        heartbeat: { write: async (beat) => void beats.push(beat) },
        onError: () => {},
      })

      await loop.runNow("chosen")

      expect([chosen.runs, other.runs]).toEqual([1, 0])
      expect(beats.at(-1)?.passes[0]?.lastSucceededAt).toEqual(START)
    })

    test("joins a run already in flight", async () => {
      const release = deferred()
      let runs = 0
      const loop = startLoop([
        intervalPass("joined", async () => {
          runs += 1
          await release.promise
        }),
      ])

      const joined = loop.runNow("joined")
      await flush()
      expect(runs).toBe(1)

      release.resolve()
      await joined
      expect(runs).toBe(1)
    })

    test("refuses a pass it does not have", async () => {
      const loop = startLoop([])

      const error = await loop.runNow("missing").catch((failure) => failure)

      expect(String(error)).toContain("Unknown maintenance pass 'missing'")
    })
  })

  test("a reporter that throws stops nothing", async () => {
    let attempts = 0
    const flaky = intervalPass(
      "flaky",
      async () => {
        attempts += 1
        throw new Error("failing")
      },
      SECOND
    )
    startLoop([flaky], {
      onError() {
        throw new Error("reporter down")
      },
    })
    await flush()

    await advance(SECOND)

    expect(attempts).toBe(2)
  })

  test("refuses two passes under one id", () => {
    const pass = countingPass("twin").pass

    expect(() => new MaintenanceLoop({ passes: [pass, pass], onError: () => {} })).toThrow(
      "Duplicate maintenance pass 'twin'"
    )
  })
})
