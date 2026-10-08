import type { Queues } from "../../queues"
import type { OntologyVectorIndexingStorage } from "../../storage/ontology/vector-indexing"

const PAGE_SIZE = 100
/** A dispatched request becomes due again only if its job has not completed it by then. */
const REDISPATCH_DELAY_MS = 30_000

/**
 * Hands durable indexing intent to the vector queue. Each commit wakes it in the committing
 * process; ontology maintenance drains it as the repair path for a wake-up that never finished.
 */
export class VectorIndexingDispatcher {
  private running: Promise<void> | null = null
  private next: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly projectId: string,
    private readonly indexing: OntologyVectorIndexingStorage,
    private readonly queue: Queues["vectorIndexing"]
  ) {}

  notify(): void {
    this.drain().catch((error) =>
      console.error("[Sixb] Could not dispatch vector indexing; maintenance will retry:", error)
    )
  }

  /** Callers share one pass plus at most one follow-up, which sees every earlier commit. */
  drain(): Promise<void> {
    this.next ??= settled(this.running).then(() => {
      this.next = null
      if (this.stopped) return
      this.running = this.pass().finally(() => {
        this.running = null
      })
      return this.running
    })
    return this.next
  }

  async stop(): Promise<void> {
    this.stopped = true
    await settled(this.next)
    await settled(this.running)
  }

  private async pass(): Promise<void> {
    for (;;) {
      const now = new Date()
      const work = await this.indexing.listDue({
        projectId: this.projectId,
        now: now.toISOString(),
        limit: PAGE_SIZE,
      })
      if (work.length) {
        const jobs = [...new Map(work.map((item) => [item.batchId ?? item.id, item])).entries()]
        await this.queue.enqueue({
          projectId: this.projectId,
          jobs: jobs.map(([id, item]) => ({
            id,
            type: "vector.index.requested",
            payload: { indexingId: id },
            availableAt: item.availableAt,
          })),
        })
        await this.indexing.dispatched({
          projectId: this.projectId,
          ids: work.map((item) => item.id),
          nextDispatchAt: new Date(now.getTime() + REDISPATCH_DELAY_MS).toISOString(),
        })
      }
      if (work.length < PAGE_SIZE || this.stopped) return
    }
  }
}

function settled(promise: Promise<void> | null): Promise<void> {
  return (promise ?? Promise.resolve()).then(
    () => undefined,
    () => undefined
  )
}
