/** How long maintenance waits for open reads to end on their own. */
const READS_WAIT_MS = 30_000

/**
 * Then it holds new reads back for this long, so reads that overlap each other cannot keep it out
 * for good. It stays short: a pipeline step that holds one input may be opening the next, and it
 * cannot finish while it waits here.
 */
const READS_DRAIN_MS = 5_000

/** A read outlasted the drain, and may be an hour long: leave new reads alone for this long. */
const DRAIN_REST_MS = 5 * 60_000

/** Reads stayed open past maintenance's wait. Its work is left to a later pass. */
export class DuckLakeReadsBusy extends Error {
  override readonly name = "DuckLakeReadsBusy"

  constructor() {
    super("[SixbDuckLake] Open reads kept lake maintenance out.")
  }
}

/** Keeps destructive maintenance outside reads, including paged overflow readers. */
export class DuckLakeReadGate {
  private active = 0
  private maintenance = false
  private draining = 0
  private drainAllowedAt = 0
  private readonly waiters = new Set<() => void>()

  async acquire(signal: AbortSignal): Promise<() => void> {
    while (true) {
      signal.throwIfAborted()
      if (!this.maintenance && this.draining === 0) {
        this.active++
        let released = false
        return () => {
          if (released) return
          released = true
          this.active--
          this.wake()
        }
      }
      await this.wait(signal)
    }
  }

  async withMaintenance<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    await this.admitMaintenance(signal)

    try {
      return await run()
    } finally {
      this.maintenance = false
      this.wake()
    }
  }

  /**
   * Waiting maintenance must let an active pipeline open the rest of its inputs, so it blocks new
   * reads only once it can start, or for one short drain. Both waits are bounded: no read holds
   * maintenance for long, and maintenance never holds a read for long.
   */
  private async admitMaintenance(signal: AbortSignal): Promise<void> {
    if (await this.claimWithin(READS_WAIT_MS, signal)) return
    if (Date.now() < this.drainAllowedAt) throw new DuckLakeReadsBusy()

    this.draining++
    const claimed = await this.claimWithin(READS_DRAIN_MS, signal).finally(() => {
      this.draining--
      this.wake()
    })
    if (claimed) return

    this.drainAllowedAt = Date.now() + DRAIN_REST_MS
    throw new DuckLakeReadsBusy()
  }

  /** Claims maintenance in the same turn it sees no read, so no woken read slips in first. */
  private async claimWithin(waitMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + waitMs

    while (this.active > 0 || this.maintenance) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return false

      const timer = setTimeout(() => this.wake(), remainingMs)
      await this.wait(signal).finally(() => clearTimeout(timer))
    }

    signal.throwIfAborted()
    this.maintenance = true
    return true
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener("abort", abort)
        this.waiters.delete(wake)
        resolve()
      }
      const abort = () => {
        this.waiters.delete(wake)
        reject(signal.reason)
      }
      signal.throwIfAborted()
      this.waiters.add(wake)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  private wake(): void {
    for (const wake of this.waiters) wake()
  }
}
