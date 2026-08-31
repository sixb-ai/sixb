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

type SyncCheckpointStrategy = "single" | "connections"

interface ConnectionCheckpointEntry {
  readonly connectionId: string
  readonly accountId: string
  readonly checkpoint?: JsonValue
}

export interface SyncCheckpointCodec {
  read(value: JsonValue | undefined): JsonValue | undefined
  serialize(value: JsonValue): JsonValue
}

/** Bind opaque handler checkpoints to the framework source contract stored beside the run. */
export function createSyncCheckpointCodec(options: {
  readonly syncId: string
  readonly connectorId: string
  readonly strategy: SyncCheckpointStrategy
}): SyncCheckpointCodec {
  return {
    read(value) {
      if (value === undefined) return undefined
      if (!isSyncCheckpoint(value)) {
        // Static Sync checkpoints predate the framework envelope. Preserve them in place and
        // migrate the next successful run; managed fan-out has no compatible legacy raw format.
        if (options.strategy === "single") return cloneJsonValue(value)
        throw incompatibleCheckpoint(options, "format")
      }
      if (value.version !== SYNC_CHECKPOINT_VERSION) {
        throw incompatibleCheckpoint(options, "version")
      }
      if (value.connectorId !== options.connectorId) {
        throw incompatibleCheckpoint(options, "connector")
      }
      if (value.strategy !== options.strategy) {
        throw incompatibleCheckpoint(options, "strategy")
      }
      if (!("value" in value) || !isJsonValue(value.value)) {
        throw invalidFrameworkCheckpoint(options.syncId)
      }
      return cloneJsonValue(value.value)
    },
    serialize(value) {
      const envelope: unknown = {
        kind: SYNC_CHECKPOINT_KIND,
        version: SYNC_CHECKPOINT_VERSION,
        connectorId: options.connectorId,
        strategy: options.strategy,
        value: cloneJsonValue(value),
      }
      assertJsonValue(envelope, "Sync checkpoint envelope")
      return envelope
    },
  }
}

/** Per-connection cursor state carried inside a framework-managed checkpoint envelope. */
export class ConnectionCheckpoints {
  private readonly entries: Map<string, ConnectionCheckpointEntry>

  private constructor(entries: Map<string, ConnectionCheckpointEntry>) {
    this.entries = entries
  }

  static from(syncId: string, value: JsonValue | undefined): ConnectionCheckpoints {
    if (value === undefined) return new ConnectionCheckpoints(new Map())
    if (!isConnectionCheckpoint(value)) throw invalidConnectionCheckpoint(syncId)

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
        throw invalidConnectionCheckpoint(syncId)
      }
      if ("checkpoint" in candidate && !isJsonValue(candidate.checkpoint)) {
        throw invalidConnectionCheckpoint(syncId)
      }
      entries.set(candidate.connectionId, {
        connectionId: candidate.connectionId,
        accountId: candidate.accountId,
        ...(candidate.checkpoint === undefined
          ? {}
          : { checkpoint: cloneJsonValue(candidate.checkpoint as JsonValue) }),
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

  serialize(): JsonValue {
    const value: unknown = {
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

function incompatibleCheckpoint(
  options: { readonly syncId: string; readonly connectorId: string },
  reason: "format" | "version" | "connector" | "strategy"
): Error {
  return createSixbError(
    "sync.execution_failed",
    `[SixbSyncWorker] Sync '${options.syncId}' has a checkpoint incompatible with connector '${options.connectorId}'. Use a new Sync id to reset its ingestion state.`,
    {
      details: {
        syncId: options.syncId,
        connectorId: options.connectorId,
        reason: `checkpoint_${reason}`,
      },
    }
  )
}

function invalidFrameworkCheckpoint(syncId: string): Error {
  return createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync '${syncId}' has an invalid checkpoint envelope.`,
    { details: { syncId } }
  )
}

function invalidConnectionCheckpoint(syncId: string): Error {
  return createSixbError(
    "internal.unexpected",
    `[SixbSyncWorker] Sync '${syncId}' has an invalid managed connector checkpoint.`,
    { details: { syncId } }
  )
}

function isSyncCheckpoint(value: JsonValue): value is JsonValue & {
  readonly kind: typeof SYNC_CHECKPOINT_KIND
  readonly version?: JsonValue
  readonly connectorId?: JsonValue
  readonly strategy?: JsonValue
  readonly value?: JsonValue
} {
  return isRecord(value) && value.kind === SYNC_CHECKPOINT_KIND
}

function isConnectionCheckpoint(value: JsonValue): value is JsonValue & {
  readonly entries: JsonValue[]
} {
  return isRecord(value) && Array.isArray(value.entries)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
