import {
  assertJsonValue,
  type BlobStorage,
  cloneJsonValue,
  type JsonValue,
  type Logger,
  type SyncConnectorConnection,
  type SyncDefinition,
} from "@sixb/core"
import { isOAuthConnectorDefinition } from "@sixb/core/internal/connector-connections"
import { createSixbError, summarizeErrorMessage } from "@sixb/core/internal/errors"
import type { SyncConnectorSource } from "@sixb/core/internal/syncs"
import {
  ConnectionCheckpoints,
  createSyncCheckpointCodec,
  type SyncCheckpointCodec,
} from "./checkpoints"
import { normalizeReadResult, runAbortable, throwIfAborted } from "./normalize"
import type { SyncWorkerContext } from "./types"

export interface SyncSourceValue {
  readonly value: unknown
  readonly connection?: SyncConnectorConnection
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
): Promise<AsyncIterable<SyncSourceValue>> {
  const sources = await options.runtime.connectorSources.list(options.sync.connector)
  if (!isOAuthConnectorDefinition(options.sync.connector)) {
    if (sources.length !== 1 || sources[0]?.connection !== undefined) {
      throw sourceInvariant(options.sync.id, "Static connectors must resolve exactly one source.")
    }
    const checkpointCodec = createSyncCheckpointCodec({
      syncId: options.sync.id,
      connectorId: options.sync.connector.id,
      strategy: "single",
    })
    return readStaticSource(options, sources[0], checkpointCodec)
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
      connect: (signal: AbortSignal) => source.connect(signal),
    }
  })
  managedSources.sort((left, right) => left.connection.id.localeCompare(right.connection.id))
  const checkpointCodec = createSyncCheckpointCodec({
    syncId: options.sync.id,
    connectorId: options.sync.connector.id,
    strategy: "connections",
  })
  const checkpoints = ConnectionCheckpoints.from(
    options.sync.id,
    checkpointCodec.read(options.previousCheckpoint)
  )
  checkpoints.reconcile(managedSources.map((source) => source.connection))
  const storeCheckpoint = () =>
    options.setCheckpoint(checkpointCodec.serialize(checkpoints.serialize()))
  storeCheckpoint()

  return readManagedSources(options, managedSources, checkpoints, storeCheckpoint)
}

async function readStaticSource(
  options: ReadSyncValuesInput,
  source: SyncConnectorSource,
  checkpointCodec: SyncCheckpointCodec
): Promise<AsyncIterable<SyncSourceValue>> {
  const previousCheckpoint = checkpointCodec.read(options.previousCheckpoint)
  if (previousCheckpoint !== undefined) {
    // Migrate legacy raw checkpoints only after the complete run succeeds.
    options.setCheckpoint(checkpointCodec.serialize(previousCheckpoint))
  }
  const client = await runAbortable(options.signal, () => source.connect(options.signal))
  throwIfAborted(options.signal)
  const readResult = await runAbortable(options.signal, () =>
    options.sync.read(
      client as never,
      {
        projectId: options.runtime.id,
        syncId: options.sync.id,
        signal: options.signal,
        blobs: options.blobStorage,
        logger: options.logger,
        checkpoint:
          previousCheckpoint === undefined ? undefined : cloneJsonValue(previousCheckpoint),
        setCheckpoint(next: unknown) {
          assertJsonValue(next, `Sync '${options.sync.id}' checkpoint`)
          options.setCheckpoint(checkpointCodec.serialize(cloneJsonValue(next)))
        },
      } as never
    )
  )
  return sourceValues(normalizeReadResult(readResult, options.sync.id, options.signal))
}

async function* readManagedSources(
  options: ReadSyncValuesInput,
  sources: readonly (SyncConnectorSource & {
    readonly connection: SyncConnectorConnection
  })[],
  checkpoints: ConnectionCheckpoints,
  storeCheckpoint: () => void
): AsyncIterable<SyncSourceValue> {
  for (const source of sources) {
    yield* readManagedSource(options, source, checkpoints, storeCheckpoint)
  }
}

async function* readManagedSource(
  options: ReadSyncValuesInput,
  source: SyncConnectorSource & { readonly connection: SyncConnectorConnection },
  checkpoints: ConnectionCheckpoints,
  storeCheckpoint: () => void
): AsyncIterable<SyncSourceValue> {
  const { connection } = source
  try {
    throwIfAborted(options.signal)
    const client = await runAbortable(options.signal, () => source.connect(options.signal))
    throwIfAborted(options.signal)
    const previous = checkpoints.get(connection)
    const readResult = await runAbortable(options.signal, () =>
      options.sync.read(
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
            storeCheckpoint()
          },
        } as never
      )
    )
    for await (const value of normalizeReadResult(readResult, options.sync.id, options.signal)) {
      yield { value, connection }
    }
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

function sourceInvariant(syncId: string, message: string): Error {
  return createSixbError("internal.unexpected", `[SixbSyncWorker] ${message}`, {
    details: { syncId },
  })
}

async function* sourceValues(values: AsyncIterable<unknown>): AsyncIterable<SyncSourceValue> {
  for await (const value of values) yield { value }
}
