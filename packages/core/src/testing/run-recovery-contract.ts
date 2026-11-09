import { afterEach, describe, expect, setSystemTime, test } from "bun:test"

/**
 * One run of one primitive, whose work blocks midway so that a test can do to it what happens to a
 * run in production. Each primitive's tests build one around its real worker.
 */
export interface RunRecoveryFixture {
  /** What a run does once the worker running it died: goes on, or ends without being replayed. */
  readonly afterCrash: "resumes" | "ends"
  /** What a run does once a deploy stopped its worker. Not every primitive has a worker to stop. */
  readonly afterShutdown: "resumes" | "ends" | "not applicable"
  /** Time after which a dead execution's hold is gone. */
  readonly leaseMs: number

  /** Queue the run and execute it until its work blocks. */
  begin(): Promise<void>
  /** Let the blocked work go on, without telling it anything else happened. */
  unblock(): void
  /** Wait until the first execution has nothing left to do. */
  firstExecutionEnded(): Promise<void>
  /** Stop the first worker as a deploy would, and wait for it. */
  stop(): Promise<void>
  /** Deliver the run's job to a new worker, and wait for the run to end. */
  redeliver(): Promise<void>
  /** Deliver another job for the same run to a new worker, and wait until it settles. */
  deliverDuplicate(): Promise<void>

  /** The durable status of the run. */
  status(): Promise<string>
  /** How many times the run's work began. */
  workStarts(): number
  /** How many copies of the run's output exist. */
  outputCopies(): Promise<number>
  dispose(): Promise<void>
}

/** The first call to `wait` blocks until `open`, or until its signal aborts. Later ones pass. */
export class RecoveryGate {
  private blocked = false
  private resolveReached!: () => void
  private resolveOpened!: () => void
  private readonly opened = new Promise<void>((resolve) => {
    this.resolveOpened = resolve
  })

  /** Resolves once something is blocked here. */
  readonly reached = new Promise<void>((resolve) => {
    this.resolveReached = resolve
  })

  async wait(signal?: AbortSignal): Promise<void> {
    if (this.blocked) return
    this.blocked = true
    this.resolveReached()

    await new Promise<void>((resolve, reject) => {
      void this.opened.then(resolve)
      if (signal?.aborted) rejectAborted(reject)
      signal?.addEventListener("abort", () => rejectAborted(reject), { once: true })
    })
  }

  open(): void {
    this.resolveOpened()
  }
}

function rejectAborted(reject: (reason: Error) => void): void {
  const error = new Error("Worker runtime aborted.")
  error.name = "AbortError"
  reject(error)
}

/**
 * The four things that happen to a run: its worker dies, a deploy stops it, two jobs deliver it,
 * and an execution that lost it wakes up. Every primitive answers them the same way, or says why
 * not through its fixture's policy.
 */
export function runRunRecoveryContractSuite(
  label: string,
  createFixture: () => Promise<RunRecoveryFixture>
): void {
  const withFixture = async (body: (fixture: RunRecoveryFixture) => Promise<void>) => {
    const fixture = await createFixture()
    try {
      await body(fixture)
    } finally {
      fixture.unblock()
      setSystemTime()
      await fixture.dispose()
    }
  }

  const leaseRunsOut = (fixture: RunRecoveryFixture) => {
    setSystemTime(new Date(Date.now() + fixture.leaseMs + 1))
  }

  describe(`${label} run recovery`, () => {
    afterEach(() => {
      setSystemTime()
    })

    test("a crash leaves the run to the next delivery", async () => {
      await withFixture(async (fixture) => {
        await fixture.begin()
        expect(await fixture.status()).toBe("running")

        leaseRunsOut(fixture)
        await fixture.redeliver()

        if (fixture.afterCrash === "resumes") {
          expect(await fixture.status()).toBe("succeeded")
          expect(await fixture.outputCopies()).toBe(1)
          expect(fixture.workStarts()).toBe(2)
        } else {
          expect(await fixture.status()).toBe("cancelled")
          expect(await fixture.outputCopies()).toBe(0)
          expect(fixture.workStarts()).toBe(1)
        }
      })
    })

    test("a clean shutdown loses nothing and does not wait out a lease", async () => {
      await withFixture(async (fixture) => {
        if (fixture.afterShutdown === "not applicable") return

        await fixture.begin()
        await fixture.stop()

        if (fixture.afterShutdown === "ends") {
          expect(await fixture.status()).toBe("cancelled")
          return
        }

        expect(await fixture.status()).toBe("running")

        await fixture.redeliver()

        expect(await fixture.status()).toBe("succeeded")
        expect(await fixture.outputCopies()).toBe(1)
      })
    })

    test("a duplicate delivery does not run the work beside the first", async () => {
      await withFixture(async (fixture) => {
        await fixture.begin()

        await fixture.deliverDuplicate()
        expect(fixture.workStarts()).toBe(1)

        fixture.unblock()
        await fixture.firstExecutionEnded()

        expect(await fixture.status()).toBe("succeeded")
        expect(await fixture.outputCopies()).toBe(1)
      })
    })

    test("an execution that lost its run changes nothing when it wakes up", async () => {
      await withFixture(async (fixture) => {
        await fixture.begin()

        leaseRunsOut(fixture)
        await fixture.redeliver()
        const settled = await fixture.status()
        const copies = await fixture.outputCopies()

        fixture.unblock()
        await fixture.firstExecutionEnded()

        expect(await fixture.status()).toBe(settled)
        expect(await fixture.outputCopies()).toBe(copies)
      })
    })
  })
}
