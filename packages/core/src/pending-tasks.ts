/**
 * Work that was started and has not finished, so shutdown can wait for it without waiting forever.
 *
 * Whoever started the work handles how it ends; this only waits, so a rejection is not reported here.
 */
export class PendingTasks {
  private readonly tasks = new Set<Promise<void>>()

  get size(): number {
    return this.tasks.size
  }

  track(task: Promise<unknown>): void {
    const settled: Promise<void> = task
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        this.tasks.delete(settled)
      })
    this.tasks.add(settled)
  }

  /**
   * Wait for the tracked work, and for work tracked meanwhile, for at most `timeoutMs`. Resolves
   * `false` when time ran out first: a task that never settles must not stop shutdown.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    while (this.tasks.size > 0) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0 || !(await this.settleWithin(remainingMs))) return false
    }
    return true
  }

  private async settleWithin(timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.all([...this.tasks]).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
