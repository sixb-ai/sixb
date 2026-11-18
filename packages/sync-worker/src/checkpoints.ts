import {
  assertJsonValue,
  cloneJsonValue,
  isJsonValue,
  type JsonValue,
  type SyncConnectorConnection,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"

const SYNC_CHECKPOINT_KIND = "sync_checkpoint"
const SYNC_CHECKPOINT_VERSION = 1

/**
 * `single` is a static connector's one cursor. `connection` is one connection's cursor, bound to
 * the account it read. `connections` held every connection's cursor when one run read them all:
 * a connection's first run of its own still starts from its entry there.
 */
type SyncCheckpointStrategy = "single" | "connection" | "connections"

interface SyncCheckpointIdentity {
  readonly syncId: string
  readonly connectorId: string
}

type SyncCheckpointEnvelope = JsonValue & {
  readonly kind: typeof SYNC_CHECKPOINT_KIND
  readonly version?: JsonValue
  readonly connectorId?: JsonValue
  readonly strategy?: JsonValue
  readonly value?: JsonValue
}

/** A static connector's checkpoint: the handler's value inside the framework envelope. */
export const singleCheckpoint = {
  read(identity: SyncCheckpointIdentity, value: JsonValue | undefined): JsonValue | undefined {
    if (value === undefined) return undefined
    // Static Sync checkpoints predate the framework envelope. Preserve them in place and migrate
    // the next successful run.
    if (!isSyncCheckpoint(value)) return cloneJsonValue(value)
    return openEnvelope(identity, value, ["single"]).value
  },
  serialize(identity: SyncCheckpointIdentity, value: JsonValue): JsonValue {
    return envelope(identity, "single", value)
  },
}

/** One connection's checkpoint. A replaced account starts over. */
export const connectionCheckpoint = {
  read(
    identity: SyncCheckpointIdentity,
    connection: SyncConnectorConnection,
    value: JsonValue | undefined
  ): JsonValue | undefined {
    if (value === undefined) return undefined
    if (!isSyncCheckpoint(value)) throw incompatibleCheckpoint(identity, "format")

    const opened = openEnvelope(identity, value, ["connection", "connections"])
    const entry =
      opened.strategy === "connection"
        ? opened.value
        : legacyEntries(identity.syncId, opened.value).find(
            (candidate) => candidate.connectionId === connection.id
          )
    if (entry === undefined) return undefined
    if (!isRecord(entry) || typeof entry.accountId !== "string") {
      throw invalidCheckpoint(identity.syncId)
    }
    if (entry.accountId !== connection.account.id || entry.checkpoint === undefined) {
      return undefined
    }
    if (!isJsonValue(entry.checkpoint)) throw invalidCheckpoint(identity.syncId)
    return cloneJsonValue(entry.checkpoint)
  },
  serialize(
    identity: SyncCheckpointIdentity,
    connection: SyncConnectorConnection,
    checkpoint: JsonValue | undefined
  ): JsonValue {
    return envelope(identity, "connection", {
      accountId: connection.account.id,
      ...(checkpoint === undefined ? {} : { checkpoint: cloneJsonValue(checkpoint) }),
    })
  },
}

function openEnvelope(
  identity: SyncCheckpointIdentity,
  value: SyncCheckpointEnvelope,
  strategies: readonly SyncCheckpointStrategy[]
): { readonly strategy: SyncCheckpointStrategy; readonly value: JsonValue } {
  if (value.version !== SYNC_CHECKPOINT_VERSION) throw incompatibleCheckpoint(identity, "version")
  if (value.connectorId !== identity.connectorId) {
    throw incompatibleCheckpoint(identity, "connector")
  }
  const strategy = strategies.find((candidate) => candidate === value.strategy)
  if (!strategy) throw incompatibleCheckpoint(identity, "strategy")
  if (!("value" in value) || !isJsonValue(value.value)) throw invalidCheckpoint(identity.syncId)
  return { strategy, value: cloneJsonValue(value.value) }
}

function envelope(
  identity: SyncCheckpointIdentity,
  strategy: SyncCheckpointStrategy,
  value: JsonValue
): JsonValue {
  const serialized: unknown = {
    kind: SYNC_CHECKPOINT_KIND,
    version: SYNC_CHECKPOINT_VERSION,
    connectorId: identity.connectorId,
    strategy,
    value: cloneJsonValue(value),
  }
  assertJsonValue(serialized, "Sync checkpoint envelope")
  return serialized
}

function legacyEntries(syncId: string, value: JsonValue): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw invalidCheckpoint(syncId)
  return value.entries.flatMap((entry) => (isRecord(entry) ? [entry] : []))
}

function incompatibleCheckpoint(
  identity: SyncCheckpointIdentity,
  reason: "format" | "version" | "connector" | "strategy"
): Error {
  return createSixbError(
    "sync.execution_failed",
    `[SixbSyncWorker] Sync '${identity.syncId}' has a checkpoint incompatible with connector '${identity.connectorId}'. Use a new Sync id to reset its ingestion state.`,
    {
      details: {
        syncId: identity.syncId,
        connectorId: identity.connectorId,
        reason: `checkpoint_${reason}`,
      },
    }
  )
}

function invalidCheckpoint(syncId: string): Error {
  return createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync '${syncId}' has an invalid checkpoint envelope.`,
    { details: { syncId } }
  )
}

function isSyncCheckpoint(value: JsonValue): value is SyncCheckpointEnvelope {
  return isRecord(value) && value.kind === SYNC_CHECKPOINT_KIND
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
