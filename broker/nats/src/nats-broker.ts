import { randomUUID } from "node:crypto"
import type { JetStreamClient, OrderedConsumerOptions, StreamInfo } from "@nats-io/jetstream"
import { DeliverPolicy, jetstream } from "@nats-io/jetstream"
import type { ConnectionOptions } from "@nats-io/nats-core"
import { type Broker, cloneJsonValue } from "@sixb/core"
import {
  BrokerCursorExpiredError,
  type BrokerPage,
  type BrokerRecord,
  type BrokerRecordInput,
  type BrokerStreamDefinition,
} from "@sixb/core/broker"
import { NatsConnectionManager } from "./connection"
import { NatsBrokerError } from "./errors"
import { validateProjectId } from "./project-id"
import { assertEncodableRecord, decodeRecord, encodeRecord } from "./serialization"
import { StreamManager } from "./stream"
import { assertNamespace, buildRecordFilters, buildRecordSubject } from "./subjects"
import { type ActiveSubscription, SubscriptionRegistry } from "./subscription-registry"

const DEFAULT_NAMESPACE = "sixb_broker"
const DEFAULT_FETCH_BATCH_SIZE = 1_000
const PUBLISH_CONCURRENCY = 256

export interface NatsBrokerOptions {
  /**
   * NATS connection options passed through to the official client. All auth
   * modes (user/pass, token, NKey, creds file, TLS) are supported via the
   * standard fields on this type.
   */
  readonly connection: ConnectionOptions
  /**
   * Prefix used in stream names and subjects. Useful for isolating tests or
   * multiple Sixb deployments on one NATS account.
   */
  readonly namespace?: string
}

/**
 * NATS JetStream-backed Broker provider.
 *
 * Implements the @sixb/core Broker contract. Each Sixb project and broker
 * stream id maps to a dedicated JetStream stream so retention, replay, and
 * purging stay isolated by logical stream. Records are addressed by NATS
 * subject tokens that include the broker record name, which lets consumers
 * filter server-side without the broker knowing events runtime domain semantics.
 *
 * Broker cursors are the JetStream stream sequence numbers of the underlying
 * messages, encoded as strings. They stay opaque to core, but this provider can
 * interpret them to start JetStream consumers and detect retention gaps.
 *
 * Subscriptions use ephemeral ordered JetStream consumers. They are live
 * fan-out by default while still allowing retained replay with
 * `from: "earliest"` or `afterCursor`. A future broker contract can add durable
 * consumer identity and ack behavior if we need restart-safe consumers.
 */
export class NatsBroker implements Broker {
  private readonly connectionManager: NatsConnectionManager
  private readonly streamManager: StreamManager
  private readonly subscriptionRegistry = new SubscriptionRegistry()
  private readonly namespace: string
  private jsClient: JetStreamClient | undefined
  private closed = false

  constructor(options: NatsBrokerOptions) {
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE
    assertNamespace(this.namespace)
    this.connectionManager = new NatsConnectionManager(options.connection)
    this.streamManager = new StreamManager({
      connectionManager: this.connectionManager,
      namespace: this.namespace,
    })
  }

  async ensureStream(params: { projectId: string; stream: BrokerStreamDefinition }): Promise<void> {
    this.assertOpen()
    await this.streamManager.ensureStream(params.projectId, params.stream)
  }

  async append(params: {
    projectId: string
    streamId: string
    records: readonly BrokerRecordInput[]
  }): Promise<readonly BrokerRecord[]> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)

    if (params.records.length === 0) {
      return []
    }

    for (const input of params.records) {
      assertEncodableRecord(input)
    }

    const streamName = await this.requireStreamName(params.projectId, params.streamId)
    const js = await this.getJetStream()
    const records: BrokerRecord[] = []

    // JetStream has no multi-message transaction. Queue bounded windows without
    // awaiting each PubAck so a logger batch costs roughly one network latency,
    // while retaining input order in the returned array. A failed window may be
    // partially committed; stable idempotency keys make generic broker retries safe.
    for (let offset = 0; offset < params.records.length; offset += PUBLISH_CONCURRENCY) {
      const window = params.records.slice(offset, offset + PUBLISH_CONCURRENCY)
      try {
        const published = await Promise.all(
          window.map(async (input): Promise<BrokerRecord> => {
            const publishedAt = new Date().toISOString()
            const subject = buildRecordSubject({
              namespace: this.namespace,
              projectId: params.projectId,
              streamId: params.streamId,
              name: input.name,
              key: input.key,
            })
            const ack = await js.publish(subject, encodeRecord(input, publishedAt), {
              msgID: input.idempotencyKey,
            })

            if (ack.duplicate) {
              return this.fetchRecordBySequence({
                streamName,
                streamId: params.streamId,
                streamSequence: ack.seq,
              })
            }

            return {
              streamId: params.streamId,
              cursor: String(ack.seq),
              name: input.name,
              key: input.key,
              payload: cloneJsonValue(input.payload),
              publishedAt,
            }
          })
        )
        records.push(...published)
      } catch (error) {
        throw new NatsBrokerError(`Failed to publish records to stream "${params.streamId}"`, {
          cause: error,
        })
      }
    }

    return records
  }

  async read(params: {
    projectId: string
    streamId: string
    afterCursor?: string
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    const streamName = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (!streamName) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    const streamInfo = await this.fetchStreamInfo(streamName)
    this.assertCursorInRetainedRange(streamInfo, params.streamId, params.afterCursor)
    if (streamInfo.state.messages === 0) {
      return { records: [], cursor: params.afterCursor, hasMore: false }
    }

    const requested = params.limit === undefined ? undefined : params.limit + 1
    const fetched = await this.fetchWindow({
      projectId: params.projectId,
      streamId: params.streamId,
      streamName,
      startSequence:
        params.afterCursor === undefined
          ? firstAvailableSequenceFor(streamInfo)
          : BigInt(params.afterCursor) + 1n,
      endSequence: BigInt(streamInfo.state.last_seq) + 1n,
      maxRecords: requested,
      names: params.names,
      keys: params.keys,
    })
    const hasMore = params.limit !== undefined && fetched.length > params.limit
    const records = hasMore ? fetched.slice(0, params.limit) : fetched
    const lastStreamCursor = String(streamInfo.state.last_seq)
    return {
      records,
      cursor: hasMore ? records.at(-1)?.cursor : maxCursor(params.afterCursor, lastStreamCursor),
      hasMore,
    }
  }

  async tail(params: {
    projectId: string
    streamId: string
    beforeCursor?: string
    limit?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<BrokerPage> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.beforeCursor)

    if (params.limit !== undefined && params.limit <= 0) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    const streamName = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (!streamName) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    const streamInfo = await this.fetchStreamInfo(streamName)
    this.assertTailCursorInRetainedRange(streamInfo, params.streamId, params.beforeCursor)
    const first = firstAvailableSequenceFor(streamInfo)
    const streamEnd = BigInt(streamInfo.state.last_seq) + 1n
    const end = params.beforeCursor === undefined ? streamEnd : BigInt(params.beforeCursor)
    if (streamInfo.state.messages === 0 || end <= first) {
      return { records: [], cursor: params.beforeCursor, hasMore: false }
    }

    if (params.limit === undefined) {
      const records = await this.fetchWindow({
        projectId: params.projectId,
        streamId: params.streamId,
        streamName,
        startSequence: first,
        endSequence: end,
        names: params.names,
        keys: params.keys,
      })
      return { records, cursor: records[0]?.cursor ?? params.beforeCursor, hasMore: false }
    }

    const target = params.limit + 1
    let span = BigInt(Math.max(DEFAULT_FETCH_BATCH_SIZE, target * 4))
    let start = end > span ? end - span : first
    if (start < first) start = first
    let fetched: readonly BrokerRecord[] = []

    while (true) {
      fetched = await this.fetchWindow({
        projectId: params.projectId,
        streamId: params.streamId,
        streamName,
        startSequence: start,
        endSequence: end,
        names: params.names,
        keys: params.keys,
      })
      if (fetched.length >= target || start === first) {
        break
      }
      span *= 2n
      start = end > span ? end - span : first
      if (start < first) start = first
    }

    const hasMore = fetched.length > params.limit
    const records = fetched.slice(Math.max(0, fetched.length - params.limit))
    return {
      records,
      cursor: records[0]?.cursor ?? params.beforeCursor ?? String(first),
      hasMore,
    }
  }

  async latestCursor(params: { projectId: string; streamId: string }): Promise<string | undefined> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)

    const streamName = await this.streamManager.getExistingStream(params.projectId, params.streamId)
    if (!streamName) {
      return undefined
    }

    const streamInfo = await this.fetchStreamInfo(streamName)
    return streamInfo.state.messages > 0 ? String(streamInfo.state.last_seq) : undefined
  }

  async subscribe(
    params: {
      projectId: string
      streamId: string
      from?: "latest" | "earliest"
      afterCursor?: string
      names?: readonly string[]
      keys?: readonly string[]
    },
    handler: (records: readonly BrokerRecord[]) => void
  ): Promise<() => void> {
    this.assertOpen()
    validateProjectId(params.projectId)
    assertStreamId(params.streamId)
    assertCursor(params.afterCursor)

    let stopped = false
    const streamName = await this.requireStreamName(params.projectId, params.streamId)
    const js = await this.getJetStream()
    const consumerOptions = this.consumerOptions({
      projectId: params.projectId,
      streamId: params.streamId,
      afterCursor: params.afterCursor,
      from: params.from,
      names: params.names,
      keys: params.keys,
      live: true,
    })
    const consumer = await js.consumers.get(streamName, consumerOptions)
    const messages = await consumer.consume()
    const pump = (async () => {
      try {
        for await (const msg of messages) {
          if (stopped) {
            break
          }

          let record: BrokerRecord
          try {
            record = decodeRecord({
              streamId: params.streamId,
              data: msg.data,
              cursor: String(msg.info.streamSequence),
              fallbackPublishedAt: msg.timestamp,
            })
          } catch (error) {
            console.error("[NatsBroker] Failed to decode subscribed record:", error)
            continue
          }

          try {
            handler([record])
          } catch {
            // Handler failures are swallowed per the Broker subscribe contract.
          }
        }
      } catch (error) {
        if (!stopped) {
          // The unsubscribe handle has no async error channel, so surface pump failures
          // through console instead of failing silently.
          console.error("[NatsBroker] Subscription pump failed:", error)
        }
      }
    })()

    const subscription: ActiveSubscription = {
      stop: () => {
        if (stopped) {
          return
        }
        stopped = true
        messages?.stop()
      },
      drain: async () => {
        await pump
      },
    }

    return this.subscriptionRegistry.register(subscription)
  }

  /**
   * Drains all active subscriptions and closes the underlying NATS connection.
   *
   * `close()` is optional on the Broker interface because in-memory providers
   * do not need teardown, but network-backed providers should expose it for
   * deterministic worker and test shutdown.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    try {
      await this.subscriptionRegistry.drain()
    } finally {
      await this.connectionManager.close()
    }
  }

  private async fetchWindow(params: {
    projectId: string
    streamId: string
    streamName: string
    startSequence: bigint
    endSequence?: bigint
    maxRecords?: number
    names?: readonly string[]
    keys?: readonly string[]
  }): Promise<readonly BrokerRecord[]> {
    const js = await this.getJetStream()
    const consumer = await js.consumers.get(
      params.streamName,
      this.consumerOptions({
        projectId: params.projectId,
        streamId: params.streamId,
        afterCursor: String(params.startSequence - 1n),
        from: "earliest",
        names: params.names,
        keys: params.keys,
        live: false,
      })
    )

    const consumerInfo = await consumer.info()
    if (consumerInfo.num_pending === 0) {
      return []
    }

    // `read()` is bounded. Use fetch() rather than consume() so missing or
    // empty streams return promptly instead of blocking indefinitely on a
    // continuous pull. The `expires` timeout bounds the wait when no messages
    // match the filter; the batch size bounds memory when the caller did not
    // provide a limit.
    const records: BrokerRecord[] = []
    let pending = consumerInfo.num_pending
    let reachedEnd = false
    while (
      pending > 0 &&
      !reachedEnd &&
      (params.maxRecords === undefined || records.length < params.maxRecords)
    ) {
      const remaining =
        params.maxRecords === undefined
          ? DEFAULT_FETCH_BATCH_SIZE
          : Math.min(DEFAULT_FETCH_BATCH_SIZE, params.maxRecords - records.length)
      const requested = Math.min(remaining, pending)
      const batch = await consumer.fetch({
        max_messages: requested,
        // JetStream client requires expires >= 1000ms. This mostly affects
        // empty reads; non-empty reads break as soon as pending reaches 0.
        expires: 1000,
      })

      let received = 0
      for await (const msg of batch) {
        received += 1
        pending = msg.info.pending
        if (
          params.endSequence !== undefined &&
          BigInt(msg.info.streamSequence) >= params.endSequence
        ) {
          reachedEnd = true
          batch.stop()
          break
        }
        records.push(
          decodeRecord({
            streamId: params.streamId,
            data: msg.data,
            cursor: String(msg.info.streamSequence),
            fallbackPublishedAt: msg.timestamp,
          })
        )

        if (
          msg.info.pending === 0 ||
          (params.maxRecords !== undefined && records.length >= params.maxRecords)
        ) {
          batch.stop()
          break
        }
      }

      if (
        received === 0 ||
        received < requested ||
        records.length >= (params.maxRecords ?? Number.POSITIVE_INFINITY)
      ) {
        break
      }
    }

    return records
  }

  private assertCursorInRetainedRange(
    streamInfo: StreamInfo,
    streamId: string,
    afterCursor: string | undefined
  ): void {
    if (afterCursor === undefined) {
      return
    }

    const requestedNextSequence = BigInt(afterCursor) + 1n
    const firstAvailableSequence = firstAvailableSequenceFor(streamInfo)

    if (requestedNextSequence < firstAvailableSequence) {
      throw new BrokerCursorExpiredError(
        `afterCursor '${afterCursor}' is outside the retained range for stream ` +
          `'${streamId}'. The next requested cursor sequence is ` +
          `'${requestedNextSequence}', but the earliest available cursor sequence is ` +
          `'${firstAvailableSequence}'.`
      )
    }
  }

  private assertTailCursorInRetainedRange(
    streamInfo: StreamInfo,
    streamId: string,
    beforeCursor: string | undefined
  ): void {
    if (beforeCursor === undefined || streamInfo.state.messages === 0) {
      return
    }
    const firstAvailableSequence = firstAvailableSequenceFor(streamInfo)
    if (BigInt(beforeCursor) < firstAvailableSequence) {
      throw new BrokerCursorExpiredError(
        `beforeCursor '${beforeCursor}' is outside the retained range for stream ` +
          `'${streamId}'. The earliest available cursor sequence is ` +
          `'${firstAvailableSequence}'.`
      )
    }
  }

  private async fetchStreamInfo(streamName: string): Promise<StreamInfo> {
    const js = await this.getJetStream()
    const stream = await js.streams.get(streamName)
    return stream.info(false)
  }

  private async requireStreamName(projectId: string, streamId: string): Promise<string> {
    const streamName = await this.streamManager.getExistingStream(projectId, streamId)
    if (!streamName) {
      throw new NatsBrokerError(
        `stream '${streamId}' has not been ensured for project '${projectId}'. Call ensureStream() before append or subscribe.`
      )
    }
    return streamName
  }

  private async fetchRecordBySequence(params: {
    streamName: string
    streamId: string
    streamSequence: number
  }): Promise<BrokerRecord> {
    const js = await this.getJetStream()
    const stream = await js.streams.get(params.streamName)
    const msg = await stream.getMessage({ seq: params.streamSequence })
    if (!msg) {
      throw new NatsBrokerError(
        `JetStream deduplicated publish at sequence ${params.streamSequence}, but the retained record was not found.`
      )
    }

    return decodeRecord({
      streamId: params.streamId,
      data: msg.data,
      cursor: String(msg.seq),
      fallbackPublishedAt: msg.timestamp,
    })
  }

  private consumerOptions(params: {
    projectId: string
    streamId: string
    afterCursor?: string
    from?: "latest" | "earliest"
    names?: readonly string[]
    keys?: readonly string[]
    live: boolean
  }): Partial<OrderedConsumerOptions> {
    const filterSubjects = buildRecordFilters({
      namespace: this.namespace,
      projectId: params.projectId,
      streamId: params.streamId,
      names: params.names,
      keys: params.keys,
    })
    const filter_subjects = filterSubjects === undefined ? undefined : [...filterSubjects]

    if (params.afterCursor !== undefined) {
      // Broker afterCursor is exclusive. JetStream StartSequence is inclusive,
      // so start at the following stream sequence.
      return {
        filter_subjects,
        deliver_policy: DeliverPolicy.StartSequence,
        opt_start_seq: Number(BigInt(params.afterCursor) + 1n),
        name_prefix: params.live ? `sixb-brk-${randomUUID().slice(0, 8)}` : undefined,
      }
    }

    if (params.from === "earliest" || !params.live) {
      return {
        filter_subjects,
        deliver_policy: DeliverPolicy.StartSequence,
        opt_start_seq: 1,
        name_prefix: params.live ? `sixb-brk-${randomUUID().slice(0, 8)}` : undefined,
      }
    }

    return {
      filter_subjects,
      deliver_policy: DeliverPolicy.New,
      name_prefix: `sixb-brk-${randomUUID().slice(0, 8)}`,
    }
  }

  private async getJetStream(): Promise<JetStreamClient> {
    if (this.jsClient !== undefined) {
      return this.jsClient
    }
    const nc = await this.connectionManager.connect()
    this.jsClient = jetstream(nc)
    return this.jsClient
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NatsBrokerError("broker has been closed")
    }
  }
}

function assertCursor(cursor: string | undefined): void {
  if (cursor === undefined) {
    return
  }

  try {
    if (BigInt(cursor) < 0n) {
      throw new NatsBrokerError("cursor must be non-negative")
    }
  } catch (error) {
    if (error instanceof NatsBrokerError) {
      throw error
    }
    throw new NatsBrokerError("cursor must be a NATS JetStream sequence cursor", { cause: error })
  }
}

function assertStreamId(streamId: string): void {
  if (streamId.trim().length === 0) {
    throw new NatsBrokerError("streamId must be a non-empty string")
  }
}

function firstAvailableSequenceFor(streamInfo: StreamInfo): bigint {
  if (streamInfo.state.messages > 0) {
    return BigInt(streamInfo.state.first_seq)
  }
  return BigInt(streamInfo.state.last_seq) + 1n
}

function maxCursor(first: string | undefined, second: string): string {
  if (first === undefined) {
    return second
  }
  return BigInt(first) >= BigInt(second) ? first : second
}
