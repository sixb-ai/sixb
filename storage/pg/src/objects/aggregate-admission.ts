/** Limit expensive root aggregates before they reserve a database connection. Pages can
 * use the remaining pool capacity. No results or object revisions are retained here. */
export class PgAggregateAdmission {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly concurrency = 1) {}

  async run<T>(compute: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      return await compute()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
