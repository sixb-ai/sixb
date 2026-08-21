import type { BrokerStreamDefinition } from "@sixb/core/broker"
import type { RedisBrokerCommandClient, RedisConnectionManager } from "./connection"
import { RedisBrokerError } from "./errors"
import { assertStreamId, type RedisStreamKeys, streamKeysFor, validateProjectId } from "./keys"
import { assertStream, normalizeRetention } from "./retention"
import { ENSURE_STREAM_SCRIPT } from "./scripts"

export interface EnsuredStream {
  readonly projectId: string
  readonly streamId: string
  readonly keys: RedisStreamKeys
}

/**
 * Owns Redis stream metadata provisioning and local stream-existence cache.
 *
 * Redis creates Stream keys on first XADD, so `ensureStream()` cannot create an
 * empty stream without adding a fake record. The metadata hash is therefore the
 * source of truth for "this broker stream has been ensured".
 */
export class StreamManager {
  private readonly connectionManager: RedisConnectionManager
  private readonly prefix: string
  private readonly knownStreams = new Map<string, EnsuredStream>()

  constructor(options: { connectionManager: RedisConnectionManager; prefix: string }) {
    this.connectionManager = options.connectionManager
    this.prefix = options.prefix
  }

  async ensureStream(projectId: string, stream: BrokerStreamDefinition): Promise<EnsuredStream> {
    validateProjectId(projectId)
    assertStream(stream)

    const keys = streamKeysFor(this.prefix, projectId, stream.id)
    const cached = this.knownStreams.get(keys.metaKey)
    if (cached !== undefined) {
      return cached
    }

    const retention = normalizeRetention(stream.retention)
    await this.connectionManager.useCommandClient(async (client) => {
      try {
        // The script creates metadata only when absent. That mirrors NATS'
        // "bind to existing stream config" behavior and avoids changing
        // production retention if a later runtime starts with different options.
        await client.send("EVAL", [
          ENSURE_STREAM_SCRIPT,
          "1",
          keys.metaKey,
          projectId,
          stream.id,
          new Date().toISOString(),
          retention.maxAgeMs === undefined ? "" : String(retention.maxAgeMs),
          retention.maxRecords === undefined ? "" : String(retention.maxRecords),
          retention.maxBytes === undefined ? "" : String(retention.maxBytes),
        ])
      } catch (error) {
        throw new RedisBrokerError(`Failed to ensure stream "${stream.id}"`, { cause: error })
      }
    })

    const ensured = { projectId, streamId: stream.id, keys }
    this.knownStreams.set(keys.metaKey, ensured)
    return ensured
  }

  async getExistingStream(projectId: string, streamId: string): Promise<EnsuredStream | null> {
    validateProjectId(projectId)
    assertStreamId(streamId)

    const keys = streamKeysFor(this.prefix, projectId, streamId)
    const cached = this.knownStreams.get(keys.metaKey)
    if (cached !== undefined) {
      return cached
    }

    const exists = await this.connectionManager.useCommandClient(async (client) => {
      try {
        return await client.exists(keys.metaKey)
      } catch (error) {
        throw new RedisBrokerError(`Failed to inspect stream "${streamId}"`, { cause: error })
      }
    })

    if (!exists) {
      return null
    }

    const ensured = { projectId, streamId, keys }
    this.knownStreams.set(keys.metaKey, ensured)
    return ensured
  }

  async requireStream(projectId: string, streamId: string): Promise<EnsuredStream> {
    const ensured = await this.getExistingStream(projectId, streamId)
    if (ensured === null) {
      throw new RedisBrokerError(
        `stream '${streamId}' has not been ensured for project '${projectId}'. Call ensureStream() before append or subscribe.`
      )
    }
    return ensured
  }

  async readMetadata(
    client: RedisBrokerCommandClient,
    ensured: EnsuredStream,
    fields: readonly string[]
  ): Promise<ReadonlyMap<string, string>> {
    let reply: Array<string | null>
    try {
      reply = await client.hmget(ensured.keys.metaKey, [...fields])
    } catch (error) {
      throw new RedisBrokerError(`Failed to read stream "${ensured.streamId}" metadata`, {
        cause: error,
      })
    }

    const values = new Map<string, string>()
    for (let index = 0; index < fields.length; index += 1) {
      const value = reply[index]
      if (value !== null) {
        values.set(fields[index]!, value)
      }
    }
    return values
  }
}
