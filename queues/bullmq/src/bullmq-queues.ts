import type {
  ActionRunRequestedQueueJob,
  AgentRunRequestedQueueJob,
  PipelineRunRequestedQueueJob,
  ProjectionRunRequestedQueueJob,
  Queues,
  SyncRunRequestedQueueJob,
  WorkflowQueueJob,
} from "@sixb/core"
import type { KeepJobs } from "bullmq"
import { type BullMqLaneShared, BullMqQueue } from "./bullmq-queue"
import {
  type BullMqConnectionInput,
  type BullMqConnections,
  resolveConnections,
} from "./connection"

const DEFAULT_PREFIX = "sixb"
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_STALLED_INTERVAL_MS = 30_000
const DEFAULT_REMOVE_ON_COMPLETE: KeepJobs = { age: 86_400, count: 1_000 }
const DEFAULT_REMOVE_ON_FAIL: KeepJobs = { age: 7 * 86_400 }

export interface BullMqQueuesOptions {
  /**
   * Redis URL, ioredis options, or an existing IORedis client. When an existing client is
   * passed, it must already have `maxRetriesPerRequest: null` set (required by BullMQ's
   * blocking fetch loop) and will be borrowed — `close()` will not quit it.
   */
  readonly connection: BullMqConnectionInput

  /** BullMQ key prefix. Defaults to `"sixb"`. */
  readonly prefix?: string

  /** Default lease duration when callers do not pass `leaseMs` to `claim()`. Defaults to 30s. */
  readonly defaultLeaseMs?: number

  /** Interval at which the stalled-job checker runs, in ms. Defaults to 30s. */
  readonly stalledInterval?: number

  /**
   * Max stalls before BullMQ moves a job to `failed`. Defaults to `Number.MAX_SAFE_INTEGER` so
   * lease expiry always redelivers — the Sixb contract leaves retry policy to the caller.
   */
  readonly maxStalledCount?: number

  /** BullMQ `removeOnComplete` policy. Defaults to `{ age: 86_400, count: 1_000 }`. */
  readonly removeOnComplete?: KeepJobs | number | boolean

  /** BullMQ `removeOnFail` policy. Defaults to `{ age: 604_800 }`. */
  readonly removeOnFail?: KeepJobs | number | boolean
}

/**
 * Redis/BullMQ-backed implementation of Sixb's `Queues` contract.
 *
 * This is the provider (container) that users instantiate. It mirrors the `Queues` /
 * `Queue<T>` split from `@sixb/core`:
 *   - `BullMqQueues`      — the provider, holds the lanes (this class)
 *   - `BullMqQueue<T>`    — one lane, typed by its job payload, implements `Queue<T>`
 *
 * The lanes (`syncRuns`, `pipelines`, `projections`, `workflows`) have different generic types,
 * which is why they cannot collapse into a single class: one `BullMqQueue<T>` cannot represent
 * every lane-specific job type at once.
 *
 * Each lane maps to one BullMQ queue per `projectId` (queue name `${projectId}:${laneId}`).
 * Two IORedis connections are opened — one for `Queue` handles and one for `Worker` handles
 * (BullMQ requires `maxRetriesPerRequest: null` on the worker connection for blocking fetches).
 */
export class BullMqQueues implements Queues {
  readonly provider = "bullmq"
  readonly syncRuns: BullMqQueue<SyncRunRequestedQueueJob>
  readonly pipelines: BullMqQueue<PipelineRunRequestedQueueJob>
  readonly projections: BullMqQueue<ProjectionRunRequestedQueueJob>
  readonly workflows: BullMqQueue<WorkflowQueueJob>
  readonly actions: BullMqQueue<ActionRunRequestedQueueJob>
  readonly agents: BullMqQueue<AgentRunRequestedQueueJob>

  private readonly connections: BullMqConnections

  constructor(options: BullMqQueuesOptions) {
    this.connections = resolveConnections(options.connection)

    const shared: BullMqLaneShared = {
      connections: this.connections,
      prefix: options.prefix ?? DEFAULT_PREFIX,
      defaultLeaseMs: options.defaultLeaseMs ?? DEFAULT_LEASE_MS,
      stalledInterval: options.stalledInterval ?? DEFAULT_STALLED_INTERVAL_MS,
      maxStalledCount: options.maxStalledCount ?? Number.MAX_SAFE_INTEGER,
      removeOnComplete: options.removeOnComplete ?? DEFAULT_REMOVE_ON_COMPLETE,
      removeOnFail: options.removeOnFail ?? DEFAULT_REMOVE_ON_FAIL,
    }

    this.syncRuns = new BullMqQueue<SyncRunRequestedQueueJob>(shared, "sync.runs")
    this.pipelines = new BullMqQueue<PipelineRunRequestedQueueJob>(shared, "pipeline.runs")
    this.projections = new BullMqQueue<ProjectionRunRequestedQueueJob>(shared, "projection.runs")
    this.workflows = new BullMqQueue<WorkflowQueueJob>(shared, "workflow.runs")
    this.actions = new BullMqQueue<ActionRunRequestedQueueJob>(shared, "action.runs")
    this.agents = new BullMqQueue<AgentRunRequestedQueueJob>(shared, "agent.runs")
  }

  async close(): Promise<void> {
    await Promise.all([
      this.syncRuns.close(),
      this.pipelines.close(),
      this.projections.close(),
      this.workflows.close(),
      this.actions.close(),
      this.agents.close(),
    ])
    // Short grace so a just-dispatched Redis command (typically the final stalled-check tick)
    // can settle on the socket before owned IORedis handles are quit. No-op when connections
    // are borrowed (callers own the socket lifecycle — see `resolveConnections`).
    await new Promise((resolve) => setTimeout(resolve, 10))
    await this.connections.close()
  }
}
