import {
  assertJsonValue,
  type BlobStorage,
  cloneJsonValue,
  isJsonValue,
  type JsonValue,
  type Logger,
  type SyncConnectorConnection,
  type SyncDefinition,
} from "@sixb/core"
import { isOAuthConnectorDefinition } from "@sixb/core/internal/connector-connections"
import { createSixbError, summarizeErrorMessage } from "@sixb/core/internal/errors"
import type { SyncConnectorSource } from "@sixb/core/internal/syncs"
import { normalizeReadResult, throwIfAborted } from "./normalize"
import type { SyncWorkerContext } from "./types"

const CONNECTION_CHECKPOINT_KIND = "connector_connections"

interface ConnectionCheckpointEntry {
  readonly connectionId: string
  readonly accountId: string
  readonly checkpoint?: JsonValue
}

interface ReadSyncValuesInput {
  readonly runtime: SyncWorkerContext
  readonly sync: SyncDefinition
  readonly runId: string
  readonly datasetId: string
  readonly signal: AbortSignal
  readonly blobStorage: BlobStorage
  readonly logger: Logger
  readonly previousCheckpoint: JsonValue | undefined
  setCheckpoint(next: JsonValue | undefined): void
}

/** Resolve and invoke every source contributing to one atomic Sync run. */
export async function readSyncValues(
  options: ReadSyncValuesInput
): Promise<AsyncIterable<unknown>> {
  const sources = await options.runtime.connectorSources.list(options.sync.connector)
  if (!isOAuthConnectorDefinition(options.sync.connector)) {
    if (sources.length !== 1 || sources[0]?.connection !== undefined) {
      throw sourceInvariant(options.sync.id, "Static connectors must resolve exactly one source.")
    }
    return readStaticSource(options, sources[0])
  }

  const connectionIds = new Set<string>()
  const managedSources = sources.map((source) => {
    if (!source.connection) {
      throw sourceInvariant(
        options.sync.id,
        "OAuth connector sources must include connection metadata."
      )
    }
    const connection = source.connection
    if (connection.connectorId !== options.sync.connector.id) {
      throw sourceInvariant(
        options.sync.id,
        `Connection '${connection.id}' belongs to connector '${connection.connectorId}', not '${options.sync.connector.id}'.`
      )
    }
    if (connectionIds.has(connection.id)) {
      throw sourceInvariant(options.sync.id, `Connection '${connection.id}' was resolved twice.`)
    }
    connectionIds.add(connection.id)
    return {
      connection,
      connect: () => source.connect(),
    }
  })
  managedSources.sort((left, right) => left.connection.id.localeCompare(right.connection.id))
  const checkpoints = ConnectionCheckpoints.from(options.sync.id, options.previousCheckpoint)
  checkpoints.reconcile(managedSources.map((source) => source.connection))
  options.setCheckpoint(checkpoints.serialize())

  return readManagedSources(options, managedSources, checkpoints)
}

async function readStaticSource(
  options: ReadSyncValuesInput,
  source: SyncConnectorSource
): Promise<AsyncIterable<unknown>> {
  const client = await source.connect()
  const readResult = await options.sync.read(
    client as never,
    {
      projectId: options.runtime.id,
      syncId: options.sync.id,
      signal: options.signal,
      blobs: options.blobStorage,
      logger: options.logger,
      checkpoint:
        options.previousCheckpoint === undefined
          ? undefined
          : cloneJsonValue(options.previousCheckpoint),
      setCheckpoint(next: unknown) {
        assertJsonValue(next, `Sync '${options.sync.id}' checkpoint`)
        options.setCheckpoint(cloneJsonValue(next))
      },
    } as never
  )
  return normalizeReadResult(readResult, options.sync.id)
}

async function* readManagedSources(
  options: ReadSyncValuesInput,
  sources: readonly (SyncConnectorSource & {
    readonly connection: SyncConnectorConnection
  })[],
  checkpoints: ConnectionCheckpoints
): AsyncIterable<unknown> {
  for (const source of sources) {
    yield* readManagedSource(options, source, checkpoints)
  }
}

async function* readManagedSource(
  options: ReadSyncValuesInput,
  source: SyncConnectorSource & { readonly connection: SyncConnectorConnection },
  checkpoints: ConnectionCheckpoints
): AsyncIterable<unknown> {
  const { connection } = source
  try {
    throwIfAborted(options.signal)
    const client = await source.connect()
    const previous = checkpoints.get(connection)
    const readResult = await options.sync.read(
      client as never,
      {
        projectId: options.runtime.id,
        syncId: options.sync.id,
        signal: options.signal,
        blobs: options.blobStorage,
        logger: options.logger,
        connection,
        checkpoint: previous === undefined ? undefined : cloneJsonValue(previous),
        setCheckpoint(next: unknown) {
          assertJsonValue(
            next,
            `Sync '${options.sync.id}' connection '${connection.id}' checkpoint`
          )
          checkpoints.set(connection, cloneJsonValue(next))
          options.setCheckpoint(checkpoints.serialize())
        },
      } as never
    )
    yield* normalizeReadResult(readResult, options.sync.id)
  } catch (error) {
    if (options.signal.aborted) throw error
    throw createSixbError(
      "sync.execution_failed",
      summarizeErrorMessage(error, "Managed connector Sync source failed."),
      {
        cause: error,
        details: {
          syncId: options.sync.id,
          runId: options.runId,
          datasetId: options.datasetId,
          connectionId: connection.id,
          accountId: connection.account.id,
        },
      }
    )
  }
}

class ConnectionCheckpoints {
  private readonly entries: Map<string, ConnectionCheckpointEntry>

  private constructor(entries: Map<string, ConnectionCheckpointEntry>) {
    this.entries = entries
  }

  static from(syncId: string, value: JsonValue | undefined): ConnectionCheckpoints {
    if (value === undefined || !isConnectionCheckpoint(value)) {
      return new ConnectionCheckpoints(new Map())
    }
    if (!Array.isArray(value.entries)) {
      throw invalidCheckpoint(syncId)
    }

    const entries = new Map<string, ConnectionCheckpointEntry>()
    for (const candidate of value.entries) {
      if (
        !isRecord(candidate) ||
        typeof candidate.connectionId !== "string" ||
        !candidate.connectionId.trim() ||
        typeof candidate.accountId !== "string" ||
        !candidate.accountId.trim() ||
        entries.has(candidate.connectionId)
      ) {
        throw invalidCheckpoint(syncId)
      }
      if ("checkpoint" in candidate && !isJsonValue(candidate.checkpoint)) {
        throw invalidCheckpoint(syncId)
      }
      entries.set(candidate.connectionId, {
        connectionId: candidate.connectionId,
        accountId: candidate.accountId,
        ...("checkpoint" in candidate
          ? { checkpoint: cloneJsonValue(candidate.checkpoint as JsonValue) }
          : {}),
      })
    }
    return new ConnectionCheckpoints(entries)
  }

  reconcile(connections: readonly SyncConnectorConnection[]): void {
    for (const connection of connections) {
      const existing = this.entries.get(connection.id)
      if (existing && existing.accountId !== connection.account.id) {
        this.entries.delete(connection.id)
      }
    }
  }

  get(connection: SyncConnectorConnection): JsonValue | undefined {
    const entry = this.entries.get(connection.id)
    if (entry?.accountId !== connection.account.id || entry.checkpoint === undefined) {
      return undefined
    }
    return cloneJsonValue(entry.checkpoint)
  }

  set(connection: SyncConnectorConnection, checkpoint: JsonValue): void {
    this.entries.set(connection.id, {
      connectionId: connection.id,
      accountId: connection.account.id,
      checkpoint: cloneJsonValue(checkpoint),
    })
  }

  serialize(): JsonValue | undefined {
    if (this.entries.size === 0) return undefined
    const value: unknown = {
      kind: CONNECTION_CHECKPOINT_KIND,
      entries: [...this.entries.values()]
        .sort((left, right) => left.connectionId.localeCompare(right.connectionId))
        .map((entry) => ({
          connectionId: entry.connectionId,
          accountId: entry.accountId,
          ...(entry.checkpoint === undefined
            ? {}
            : { checkpoint: cloneJsonValue(entry.checkpoint) }),
        })),
    }
    assertJsonValue(value, "Managed connector Sync checkpoint")
    return value
  }
}

function isConnectionCheckpoint(value: JsonValue | undefined): value is JsonValue & {
  readonly kind: typeof CONNECTION_CHECKPOINT_KIND
  readonly entries?: JsonValue
} {
  return isRecord(value) && value.kind === CONNECTION_CHECKPOINT_KIND
}

function invalidCheckpoint(syncId: string): Error {
  return createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync '${syncId}' has an invalid managed connector checkpoint.`,
    { details: { syncId } }
  )
}

function sourceInvariant(syncId: string, message: string): Error {
  return createSixbError("internal.unexpected", `[SixbSyncWorker] ${message}`, {
    details: { syncId },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
