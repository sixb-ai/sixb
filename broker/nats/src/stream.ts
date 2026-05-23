import {
  DiscardPolicy,
  type JetStreamManager,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream"
import type { BrokerRetention, BrokerStreamDefinition } from "@sixb/core"
import type { NatsConnectionManager } from "./connection"
import { NatsBrokerError } from "./errors"
import { validateProjectId } from "./project-id"
import { buildStreamSubject, encodeSubjectToken } from "./subjects"

/**
 * Build the JetStream stream name for a broker stream.
 *
 * Format: `SIXB_BRK_{namespace}_{projectId}_{encodedStreamId}`. The `BRK_`
 * infix distinguishes broker streams from older event streams and leaves
 * room for other Sixb-owned JetStream resources.
 */
export function streamNameFor(namespace: string, projectId: string, streamId: string): string {
  return `SIXB_BRK_${namespace}_${projectId}_${encodeSubjectToken(streamId)}`
}

/**
 * Owns JetStream stream provisioning on behalf of NatsBroker.
 *
 * Each Sixb project and broker stream id maps to its own JetStream stream.
 * That gives events, future agent messages, and any other broker-backed lanes
 * independent retention, replay, and purging semantics. The manager caches
 * stream names it has already verified so repeat append/read/subscribe calls
 * do not pay a JetStream admin round trip.
 *
 * Concurrency: `ensureStream` may be called concurrently for the same
 * projectId and stream id. `jsm.streams.add()` is idempotent on the server, so
 * a racing duplicate create is harmless. We accept the small wasted call over
 * introducing an in-process lock.
 */
export class StreamManager {
  private readonly connectionManager: NatsConnectionManager
  private readonly namespace: string
  private readonly knownStreams = new Set<string>()
  private jsmPromise: Promise<JetStreamManager> | undefined

  constructor(options: { connectionManager: NatsConnectionManager; namespace: string }) {
    this.connectionManager = options.connectionManager
    this.namespace = options.namespace
  }

  /**
   * Ensures the broker stream exists and returns its JetStream stream name.
   *
   * If a stream with the same name already exists with a different
   * configuration, we leave the existing configuration untouched. This lets
   * operators pre-provision streams with custom retention/storage settings and
   * keeps provider startup from unexpectedly rewriting production streams.
   */
  async ensureStream(projectId: string, stream: BrokerStreamDefinition): Promise<string> {
    validateProjectId(projectId)
    assertStream(stream)
    const name = streamNameFor(this.namespace, projectId, stream.id)

    if (this.knownStreams.has(name)) {
      return name
    }

    const jsm = await this.getJsm()

    try {
      await jsm.streams.info(name)
      // Stream exists; bind to it as-is.
      this.knownStreams.add(name)
      return name
    } catch (error) {
      if (!isStreamNotFoundError(error)) {
        throw new NatsBrokerError(`Failed to inspect stream "${name}"`, { cause: error })
      }
    }

    try {
      await jsm.streams.add({
        name,
        subjects: [buildStreamSubject(this.namespace, projectId, stream.id)],
        storage: StorageType.File,
        retention: RetentionPolicy.Limits,
        discard: DiscardPolicy.Old,
        ...toRetentionConfig(stream.retention),
      })
    } catch (error) {
      // A concurrent call may have created the stream between info() and add().
      // Accept that and proceed; genuine creation failures are rethrown.
      if (!isStreamAlreadyExistsError(error)) {
        throw new NatsBrokerError(`Failed to create stream "${name}"`, { cause: error })
      }
    }

    this.knownStreams.add(name)
    return name
  }

  async getExistingStream(projectId: string, streamId: string): Promise<string | null> {
    validateProjectId(projectId)
    assertStreamId(streamId)
    const name = streamNameFor(this.namespace, projectId, streamId)

    if (this.knownStreams.has(name)) {
      return name
    }

    const jsm = await this.getJsm()
    try {
      await jsm.streams.info(name)
      this.knownStreams.add(name)
      return name
    } catch (error) {
      if (isStreamNotFoundError(error)) {
        return null
      }
      throw new NatsBrokerError(`Failed to inspect stream "${name}"`, { cause: error })
    }
  }

  private async getJsm(): Promise<JetStreamManager> {
    if (this.jsmPromise !== undefined) {
      return this.jsmPromise
    }
    this.jsmPromise = (async () => {
      const nc = await this.connectionManager.connect()
      return jetstreamManager(nc)
    })()
    try {
      return await this.jsmPromise
    } catch (error) {
      this.jsmPromise = undefined
      throw error
    }
  }
}

function assertStream(stream: BrokerStreamDefinition): void {
  if (stream.id.trim().length === 0) {
    throw new NatsBrokerError("stream.id must be a non-empty string")
  }
}

function assertStreamId(streamId: string): void {
  if (streamId.trim().length === 0) {
    throw new NatsBrokerError("streamId must be a non-empty string")
  }
}

function toRetentionConfig(retention: BrokerRetention | undefined): {
  readonly max_age?: number
  readonly max_msgs?: number
} {
  // JetStream uses 0/-1 as "unlimited" sentinels. Broker retention stays
  // optional so callers can choose unbounded streams, but events runtime usage
  // passes an explicit short maxAgeMs by default.
  return {
    max_age: retention?.maxAgeMs === undefined ? 0 : Math.max(1, retention.maxAgeMs) * 1_000_000,
    max_msgs: retention?.maxRecords === undefined ? -1 : Math.max(0, retention.maxRecords),
  }
}

/**
 * Detect a "stream not found" error from jsm.streams.info without coupling to
 * the library's error-class import path, which has varied across nats.js 3.x
 * minor releases.
 */
function isStreamNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const message = (error as { message?: unknown }).message
  const code = (error as { code?: unknown }).code
  const apiError = (error as { api_error?: { err_code?: unknown } }).api_error
  if (typeof message === "string" && /stream not found/i.test(message)) {
    return true
  }
  if (code === 404) {
    return true
  }
  if (apiError !== undefined && apiError.err_code === 10059) {
    // 10059 is the JetStream API error code for "stream not found".
    return true
  }
  return false
}

/**
 * Detect a "stream name already in use" conflict from jsm.streams.add. This
 * can happen when a concurrent call created the stream between our info() and
 * add() calls.
 */
function isStreamAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false
  }
  const message = (error as { message?: unknown }).message
  const apiError = (error as { api_error?: { err_code?: unknown } }).api_error
  if (typeof message === "string" && /already in use|already exists/i.test(message)) {
    return true
  }
  if (apiError !== undefined && apiError.err_code === 10058) {
    // 10058 is the JetStream API error code for "stream name in use".
    return true
  }
  return false
}
