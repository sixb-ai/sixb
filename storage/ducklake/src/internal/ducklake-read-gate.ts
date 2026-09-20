/** Keeps destructive maintenance outside reads, including paged overflow readers. */
export class DuckLakeReadGate {
  private active = 0
  private maintenance = false
  private readonly waiters = new Set<() => void>()

  async acquire(signal: AbortSignal): Promise<() => void> {
    while (true) {
      signal.throwIfAborted()
      if (!this.maintenance) {
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
    // Waiting maintenance must let an active pipeline open the rest of its inputs. Only block
    // new reads once maintenance can actually start; continuous reads may defer it indefinitely.
    while (this.active > 0 || this.maintenance) await this.wait(signal)
    signal.throwIfAborted()
    this.maintenance = true
    try {
      return await run()
    } finally {
      this.maintenance = false
      this.wake()
    }
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
