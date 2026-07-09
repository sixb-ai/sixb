import type { JsonValue } from "../json"

/**
 * Opaque broker cursor.
 *
 * Cursors are provider-owned tokens. Core must not parse, increment, compare,
 * or assume ordering from the cursor format.
 */
export type BrokerCursor = string

export interface BrokerRetention {
  readonly maxAgeMs?: number
  readonly maxRecords?: number
  /** Provider-accounted retained bytes. Oldest records are discarded first. */
  readonly maxBytes?: number
}

export interface BrokerStreamDefinition {
  readonly id: string
  readonly retention?: BrokerRetention
}

export interface BrokerRecordInput {
  readonly name?: string
  readonly key?: string
  readonly payload: JsonValue
  readonly idempotencyKey?: string
}

export interface BrokerRecord {
  readonly streamId: string
  readonly cursor: BrokerCursor
  readonly name?: string
  readonly key?: string
  readonly payload: JsonValue
  readonly publishedAt: string
}

/** One directional broker page plus the opaque cursor to continue from. */
export interface BrokerPage {
  readonly records: readonly BrokerRecord[]
  /** Last record scanned in the requested direction, even when no record matched. */
  readonly cursor?: BrokerCursor
  /** Whether the provider may have more records to scan in the requested direction. */
  readonly hasMore: boolean
}

export interface Broker {
  /** Ensures a retained stream exists for the given project. */
  ensureStream(params: { projectId: string; stream: BrokerStreamDefinition }): Promise<void>

  /** Appends records to an ensured stream. */
  append(params: {
    projectId: string
    streamId: string
    records: readonly BrokerRecordInput[]
  }): Promise<readonly BrokerRecord[]>

  /**
   * Reads retained records after an exclusive cursor. `limit` applies after
   * filtering by `names` and `keys`. The returned cursor advances over scanned
   * non-matches, so repeated filtered reads always make progress.
   *
   * Providers must reject `afterCursor` values that are older than the retained
   * range instead of silently advancing to the first retained record.
   */
  read(params: {
    projectId: string
    streamId: string
    afterCursor?: BrokerCursor
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage>

  /**
   * Reads the most recent retained records before an exclusive cursor. Records
   * are returned oldest-first; `cursor` points at the oldest record scanned and
   * can be passed back as `beforeCursor` to continue toward older history.
   */
  tail(params: {
    projectId: string
    streamId: string
    beforeCursor?: BrokerCursor
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage>

  /**
   * Returns the latest retained cursor without reading the stream contents.
   * Returns undefined when the stream is missing or has no retained records.
   */
  latestCursor(params: { projectId: string; streamId: string }): Promise<BrokerCursor | undefined>

  /**
   * Subscribes to retained/live records. Defaults to `from: "latest"` unless
   * `afterCursor` is provided.
   */
  subscribe(
    params: {
      projectId: string
      streamId: string
      from?: "latest" | "earliest"
      afterCursor?: BrokerCursor
      names?: readonly string[]
      keys?: readonly string[]
    },
    handler: (records: readonly BrokerRecord[]) => void
  ): Promise<() => void>

  close?(): Promise<void>
}
