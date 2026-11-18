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
import { createSixbError, isSixbError, summarizeErrorMessage } from "@sixb/core/internal/errors"
import type { SyncConnectorSource } from "@sixb/core/internal/syncs"
import type { SyncRunRecord } from "@sixb/core/storage"
import { connectionCheckpoint, singleCheckpoint } from "./checkpoints"
import { normalizeReadResult, runAbortable, throwIfAborted } from "./normalize"
import type { SyncWorkerContext } from "./types"

export interface SyncSourceValue {
  readonly value: unknown
  readonly connection?: SyncConnectorConnection
}

/** What one run reads: a static connector's client, or one connection of an OAuth connector. */
export type SyncRunSource =
  | { readonly kind: "static"; readonly source: SyncConnectorSource }
  | {
      readonly kind: "connection"
      readonly source: SyncConnectorSource
      readonly connection: SyncConnectorConnection
    }

/** The run has nothing left to read, so it ends `cancelled` without reading. */
export class SyncRunSourceGoneError extends Error {
  override readonly name = "SyncRunSourceGoneError"
}

/**
 * Resolve what this run reads. A sync of an OAuth connector runs once per connection, so a run
 * reads the connection it was queued for, and ends without reading if that connection is no longer
 * connected or its owner was suspended since.
 */
export async function resolveSyncRunSource(
  runtime: SyncWorkerContext,
  sync: SyncDefinition,
  run: Pick<SyncRunRecord, "id" | "connectionId">
): Promise<SyncRunSource> {
  const sources = await runtime.connectorSources.list(sync.connector)

  if (!isOAuthConnectorDefinition(sync.connector)) {
    if (run.connectionId !== undefined) {
      throw sourceInvariant(sync.id, `Static connector run '${run.id}' names a connection.`)
    }
    const [source] = sources
    if (sources.length !== 1 || !source || source.connection !== undefined) {
      throw sourceInvariant(sync.id, "Static connectors must resolve exactly one source.")
    }
    return { kind: "static", source }
  }

  if (run.connectionId === undefined) {
    throw new SyncRunSourceGoneError(
      `[SixbSyncWorker] Sync run '${run.id}' was queued before a sync of an OAuth connector ran once per connection. The sync's next trigger runs each connection.`
    )
  }

  const source = sources.find((candidate) => candidate.connection?.id === run.connectionId)
  if (!source?.connection) {
    throw new SyncRunSourceGoneError(
      `[SixbSyncWorker] Connection '${run.connectionId}' of sync '${sync.id}' is no longer connected, or its owner is suspended.`
    )
  }
  if (source.connection.connectorId !== sync.connector.id) {
    throw sourceInvariant(
      sync.id,
      `Connection '${source.connection.id}' belongs to connector '${source.connection.connectorId}', not '${sync.connector.id}'.`
    )
  }
  return { kind: "connection", source, connection: source.connection }
}

interface ReadSyncValuesInput {
  readonly runtime: SyncWorkerContext
  readonly sync: SyncDefinition
  readonly source: SyncRunSource
  readonly runId: string
  readonly datasetId: string
  readonly signal: AbortSignal
  readonly blobStorage: BlobStorage
  readonly logger: Logger
  readonly previousCheckpoint: JsonValue | undefined
  setCheckpoint(next: JsonValue | undefined): void
}

/** Invoke the source of one atomic Sync run. */
export async function readSyncValues(
  options: ReadSyncValuesInput
): Promise<AsyncIterable<SyncSourceValue>> {
  const { source } = options
  return source.kind === "static"
    ? readStaticSource(options, source.source)
    : readConnectionSource(options, source.source, source.connection)
}

async function readStaticSource(
  options: ReadSyncValuesInput,
  source: SyncConnectorSource
): Promise<AsyncIterable<SyncSourceValue>> {
  const identity = checkpointIdentity(options.sync)
  const previousCheckpoint = singleCheckpoint.read(identity, options.previousCheckpoint)
  if (previousCheckpoint !== undefined) {
    // Migrate legacy raw checkpoints only after the complete run succeeds.
    options.setCheckpoint(singleCheckpoint.serialize(identity, previousCheckpoint))
  }
  const client = await runAbortable(options.signal, () => source.connect(options.signal))
  throwIfAborted(options.signal)
  const readResult = await runAbortable(options.signal, () =>
    options.sync.read(
      client as never,
      {
        ...readContext(options),
        checkpoint:
          previousCheckpoint === undefined ? undefined : cloneJsonValue(previousCheckpoint),
        setCheckpoint(next: unknown) {
          assertJsonValue(next, `Sync '${options.sync.id}' checkpoint`)
          options.setCheckpoint(singleCheckpoint.serialize(identity, cloneJsonValue(next)))
        },
      } as never
    )
  )
  return sourceValues(normalizeReadResult(readResult, options.sync.id, options.signal))
}

async function* readConnectionSource(
  options: ReadSyncValuesInput,
  source: SyncConnectorSource,
  connection: SyncConnectorConnection
): AsyncIterable<SyncSourceValue> {
  const identity = checkpointIdentity(options.sync)
  const previous = connectionCheckpoint.read(identity, connection, options.previousCheckpoint)
  // A checkpoint carried from an older format becomes this connection's own on success.
  options.setCheckpoint(connectionCheckpoint.serialize(identity, connection, previous))

  try {
    throwIfAborted(options.signal)
    let client: unknown
    try {
      client = await runAbortable(options.signal, () => source.connect(options.signal))
    } catch (error) {
      if (isSixbError(error) && error.code === "connector.authorization_required") {
        throw needsReconnecting(options, connection, error)
      }
      throw error
    }
    throwIfAborted(options.signal)

    const readResult = await runAbortable(options.signal, () =>
      options.sync.read(
        client as never,
        {
          ...readContext(options),
          connection,
          checkpoint: previous === undefined ? undefined : cloneJsonValue(previous),
          setCheckpoint(next: unknown) {
            assertJsonValue(
              next,
              `Sync '${options.sync.id}' connection '${connection.id}' checkpoint`
            )
            options.setCheckpoint(
              connectionCheckpoint.serialize(identity, connection, cloneJsonValue(next))
            )
          },
        } as never
      )
    )
    for await (const value of normalizeReadResult(readResult, options.sync.id, options.signal)) {
      yield { value, connection }
    }
  } catch (error) {
    if (options.signal.aborted) throw error
    if (isSixbError(error) && error.code === "connector.authorization_required") throw error
    throw createSixbError(
      "sync.execution_failed",
      summarizeErrorMessage(error, "Connector connection Sync source failed."),
      { cause: error, details: connectionDetails(options, connection) }
    )
  }
}

/**
 * The connection's grant can no longer give a token. Its owner reconnects it, and the next run
 * resumes from its checkpoint. A person's own connection is theirs to fix, so it is not reported.
 */
function needsReconnecting(
  options: ReadSyncValuesInput,
  connection: SyncConnectorConnection,
  cause: unknown
): Error {
  if (connection.owner.type === "user") {
    console.warn(
      `[SixbSyncWorker] Sync '${options.sync.id}' could not read connection '${connection.id}': it needs reconnecting.`
    )
  }
  return createSixbError(
    "connector.authorization_required",
    `[SixbSyncWorker] Connection '${connection.id}' of sync '${options.sync.id}' needs reconnecting.`,
    {
      cause,
      details: { ...connectionDetails(options, connection), ownerType: connection.owner.type },
    }
  )
}

function readContext(options: ReadSyncValuesInput) {
  return {
    projectId: options.runtime.id,
    syncId: options.sync.id,
    signal: options.signal,
    blobs: options.blobStorage,
    logger: options.logger,
  }
}

function checkpointIdentity(sync: SyncDefinition) {
  return { syncId: sync.id, connectorId: sync.connector.id }
}

function connectionDetails(options: ReadSyncValuesInput, connection: SyncConnectorConnection) {
  return {
    syncId: options.sync.id,
    runId: options.runId,
    datasetId: options.datasetId,
    connectionId: connection.id,
    accountId: connection.account.id,
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
