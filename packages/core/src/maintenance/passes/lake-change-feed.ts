import { createSixbError } from "@sixb/core/internal/errors"
import type {
  DatasetLatestVersionSummary,
  LakeStorage,
  LatestVersionsSince,
} from "@sixb/core/lake-storage"

export interface LakeChangeFeedInput {
  readonly lakeStorage: Pick<LakeStorage, "listLatestVersionsSince">
  readonly projectId: string
  /** How long one read answers everyone: the passes that share it run about this often. */
  readonly freshForMs: number
  readonly now?: () => number
}

export interface LakeChangeReader {
  /** The newest data-bearing version of each of its datasets that moved since its last read. */
  read(): Promise<readonly DatasetLatestVersionSummary[]>
}

interface Subscriber {
  readonly datasetIds: ReadonlySet<string>
  /** The cursor stopped being a position in this lake: what it vouched for must be read again. */
  readonly onCursorLost: () => void
  /** What the feed returned that this subscriber has not read yet. */
  readonly unread: Map<string, DatasetLatestVersionSummary>
}

/**
 * The lake's change feed for everything in this process that polls it: one cursor, in memory, and
 * one catalog query per `freshForMs`, whoever asks and however many ask. Each subscriber gets what
 * moved since its own last read, so passes that run at different moments miss nothing and read
 * nothing twice.
 *
 * A read that fails reaches whoever asked and costs nothing: the cursor stays where it was.
 */
export class LakeChangeFeed {
  private readonly subscribers: Subscriber[] = []
  private readonly now: () => number
  private cursor: string | null = null
  private readAt: number | null = null
  private reading: Promise<void> | null = null

  constructor(private readonly input: LakeChangeFeedInput) {
    this.now = input.now ?? Date.now
  }

  subscribe(input: {
    readonly datasetIds: Iterable<string>
    readonly onCursorLost: () => void
  }): LakeChangeReader {
    const subscriber: Subscriber = {
      datasetIds: new Set(input.datasetIds),
      onCursorLost: input.onCursorLost,
      unread: new Map(),
    }
    this.subscribers.push(subscriber)

    return { read: () => this.readFor(subscriber) }
  }

  private async readFor(subscriber: Subscriber): Promise<readonly DatasetLatestVersionSummary[]> {
    if (!this.isFresh()) {
      this.reading ??= this.refresh().finally(() => {
        this.reading = null
      })
    }
    await this.reading

    const versions = [...subscriber.unread.values()]
    subscriber.unread.clear()
    return versions
  }

  private isFresh(): boolean {
    return this.readAt !== null && this.now() - this.readAt < this.input.freshForMs
  }

  private async refresh(): Promise<void> {
    const changes = await this.readFeed()
    this.cursor = changes.cursor
    this.readAt = this.now()

    for (const version of changes.versions) {
      for (const subscriber of this.subscribers) {
        if (subscriber.datasetIds.has(version.datasetId)) {
          subscriber.unread.set(version.datasetId, version)
        }
      }
    }
  }

  private async readFeed(): Promise<LatestVersionsSince> {
    const datasetIds = [...new Set(this.subscribers.flatMap(({ datasetIds }) => [...datasetIds]))]
    const read = (cursor: string | null) =>
      this.input.lakeStorage.listLatestVersionsSince({ cursor, datasetIds })

    const changes = await read(this.cursor)
    if (changes) return changes

    for (const subscriber of this.subscribers) subscriber.onCursorLost()

    const restarted = await read(null)
    if (restarted) return restarted

    throw createSixbError(
      "internal.unexpected",
      "[SixbOrchestrator] Lake change feed rejected a null cursor.",
      { details: { projectId: this.input.projectId } }
    )
  }
}
