import type { BlobStorage, FileRef } from "../../blob-storage/types"
import type { ReadonlyJsonObject } from "../../json"
import type { AgentQueueJob, Queue } from "../../queues"
import type { SixbHostContext } from "../../runtime/types"
import type { AiModelCallOperationRecord, AiUsageStorage } from "../../storage"
import type { ExecutionRecord } from "../../storage/executions"
import type { ModelCatalog } from "../catalog"
import type { ModelCallEndEvent, ModelUsage } from "../events"
import type { AiModelCallRecorder } from "../execution/model-call-recorder"
import { createExecutionRecorder } from "../execution/session"
import { estimateModelCall, type ModelCallCost } from "../pricing"
import type { ModelPricingDimensions } from "../rate-card"
import { assertVideoModel } from "./catalog"
import { VideoModelResponseError } from "./errors"
import type { VideoData, VideoModel, VideoModelResponseMetadata, VideoModelStatus } from "./types"

/**
 * How long a generation may stay pending before Sixb gives up on it. The Gateway waits ten minutes
 * on a provider's task, and providers' own task timeouts are ten minutes at most: a job pending for
 * an hour will not finish, and a hosted result that late would be gone anyway.
 */
export const VIDEO_GENERATION_CEILING_MS = 60 * 60_000

/** The scheduled check waits a quarter of a generation's age, from one minute up to five. */
const SCHEDULED_CHECK_MIN_DELAY_MS = 60_000
const SCHEDULED_CHECK_MAX_DELAY_MS = 5 * 60_000

/** What the operation record keeps to price the call once it ends. */
export interface StoredVideoRequest {
  readonly n: number
  readonly durationSeconds?: number
  readonly dimensions?: ModelPricingDimensions
  readonly warnings: readonly string[]
}

/** What a settled call reported, for every later look at it. */
export interface StoredVideoResult {
  readonly usage: Omit<ModelUsage, "raw">
  readonly cost: ModelCallCost
  readonly warnings: readonly string[]
}

/** What checking on a generation needs, in a request or in a queue job. */
export interface VideoCheckContext {
  readonly projectId: string
  readonly storage: Pick<SixbHostContext["storage"], "executions"> & {
    readonly aiUsage: AiUsageStorage
  }
  readonly catalog: ModelCatalog | undefined
  readonly blobs: BlobStorage | undefined
  /** The recorder of the execution attempt that admitted the call. */
  accountingFor(execution: ExecutionRecord, attempt: number): Promise<AiModelCallRecorder>
}

/**
 * Look at a pending generation once. The look that sees it end records the call as the attempt
 * that admitted it, stores the videos and settles it; past the ceiling, a job still running, or
 * one Sixb can no longer ask about, is settled as failed. Returns the record as it now stands.
 */
export async function checkVideoOperation(
  context: VideoCheckContext,
  record: AiModelCallOperationRecord,
  options: { readonly binding?: VideoModel; readonly signal: AbortSignal }
): Promise<AiModelCallOperationRecord> {
  const pastCeiling = Date.now() - record.createdAt.getTime() >= VIDEO_GENERATION_CEILING_MS

  let model: VideoModel
  let status: VideoModelStatus
  try {
    model = await resolveVideoModel(options.binding ?? catalogModel(context.catalog, record))
    status = await model.status({ operation: record.operation, signal: options.signal })
  } catch (error) {
    if (pastCeiling) return expire(context, record)
    throw error
  }

  if (status?.status === "pending") return pastCeiling ? expire(context, record) : record
  if (status?.status !== "completed" && status?.status !== "failed") {
    throw new VideoModelResponseError(
      "[SixbModels] Invalid video status response.",
      model.providerId,
      model.modelId,
      {}
    )
  }

  const accounting = await originAccounting(context, record)
  const stored = storedVideoRequest(record)
  if (status.status === "failed") {
    const event = await recordVideos(accounting, model, record, stored, status, 0)
    return settle(context, record, event, stored.warnings, describeFailure(status.error))
  }

  // A completed, billable reply is recorded before its videos are checked or stored.
  const returned = Array.isArray(status.output?.videos) ? status.output.videos : undefined
  const event = await recordVideos(accounting, model, record, stored, status, returned?.length)
  const warnings = [...stored.warnings, ...(isWarnings(status.warnings) ? status.warnings : [])]
  if (!returned?.length || !returned.every(isVideoData)) {
    return settle(context, record, event, warnings, "The provider returned no readable video.")
  }

  const blobs = context.blobs
  if (!blobs) throw new Error("[SixbModels] Video generation requires blob storage.")
  const files: FileRef[] = []
  for (const video of returned) {
    files.push(
      await blobs.put({
        body: video.data,
        expectedSizeBytes: video.data.byteLength,
        mediaType: video.mediaType,
      })
    )
  }
  await accounting.recordFiles(record.callId, files)

  return settle(context, record, event, warnings)
}

export function storedVideoRequest(record: AiModelCallOperationRecord): StoredVideoRequest {
  return record.request as unknown as StoredVideoRequest
}

export function storedVideoResult(record: AiModelCallOperationRecord): StoredVideoResult {
  return record.result as unknown as StoredVideoResult
}

// ── The scheduled check ─────────────────────────────────────

/** The host a queue job checks a generation with, outside any request. */
export type VideoCheckHost = Pick<SixbHostContext, "projectId" | "storage" | "queues"> & {
  readonly catalog: ModelCatalog | undefined
  readonly blobs: BlobStorage | undefined
}

function checkJobId(callId: string): string {
  return `agt_model_call_check_${callId}`
}

/**
 * Check on a generation later from the agent worker's queue, so it settles, and its budget is
 * released, even when no client asks again. One job per call: scheduling again moves it.
 */
export async function scheduleVideoCheck(
  queue: Pick<Queue<AgentQueueJob>, "enqueue">,
  record: Pick<AiModelCallOperationRecord, "projectId" | "callId" | "createdAt">
): Promise<void> {
  const age = Date.now() - record.createdAt.getTime()
  const delay = Math.min(
    Math.max(age / 4, SCHEDULED_CHECK_MIN_DELAY_MS),
    SCHEDULED_CHECK_MAX_DELAY_MS
  )
  await queue.enqueue({
    projectId: record.projectId,
    jobs: [
      {
        id: checkJobId(record.callId),
        type: "agent.model-call.check.requested",
        payload: { callId: record.callId },
        availableAt: new Date(Date.now() + delay).toISOString(),
        replace: true,
      },
    ],
  })
}

/**
 * The agent worker's check job: look at the generation once, then schedule the next look while it
 * runs. A failure to ask throws, and the worker retries the job.
 */
export async function runScheduledVideoCheck(
  host: VideoCheckHost,
  callId: string,
  signal: AbortSignal
): Promise<void> {
  const aiUsage = host.storage.aiUsage
  if (!aiUsage) throw new Error("[SixbModels] Video generation requires storage.aiUsage.")

  const record = await aiUsage.getModelCallOperation({ projectId: host.projectId, callId })
  if (!record || record.modelKind !== "video" || record.status !== "pending") return

  const checked = await checkVideoOperation(
    {
      projectId: host.projectId,
      storage: { executions: host.storage.executions, aiUsage },
      catalog: host.catalog,
      blobs: host.blobs,
      accountingFor: async (execution, attempt) =>
        createExecutionRecorder(host, execution, attempt),
    },
    record,
    { signal }
  )
  if (checked.status === "pending") await scheduleVideoCheck(host.queues.agents, checked)
}

// ── Settling ────────────────────────────────────────────────

/** The recorder of the attempt that admitted the call, holding the budget it reserved. */
async function originAccounting(
  context: VideoCheckContext,
  record: AiModelCallOperationRecord
): Promise<AiModelCallRecorder> {
  const origin = await context.storage.executions.getById({
    projectId: context.projectId,
    id: record.executionId,
  })
  if (!origin) {
    throw new Error(`[SixbModels] Video generation '${record.callId}' has no execution record.`)
  }

  const accounting = await context.accountingFor(origin, record.attempt)
  accounting.resumeCall(record.callId, record.reserved)
  return accounting
}

/**
 * Give up on a generation past the ceiling. Whether the provider billed it is unknown, so its
 * reservation becomes unknown, as for a language call that never finished: recording it as free
 * could under-count a job the provider charged for.
 */
async function expire(
  context: VideoCheckContext,
  record: AiModelCallOperationRecord
): Promise<AiModelCallOperationRecord> {
  const accounting = await originAccounting(context, record)
  await accounting.markCallUnknown(record.callId)

  const minutes = VIDEO_GENERATION_CEILING_MS / 60_000
  const result: StoredVideoResult = {
    usage: {},
    cost: { status: "unpriceable", reason: "missing-usage" },
    warnings: storedVideoRequest(record).warnings,
  }
  return settleRecord(context, record, {
    error: `The provider did not finish the video within ${minutes} minutes.`,
    result,
  })
}

async function settle(
  context: VideoCheckContext,
  record: AiModelCallOperationRecord,
  event: ModelCallEndEvent,
  warnings: readonly string[],
  error?: string
): Promise<AiModelCallOperationRecord> {
  const { raw: _, ...usage } = event.usage
  return settleRecord(context, record, {
    ...(error === undefined ? {} : { error }),
    result: { usage, cost: event.cost, warnings },
  })
}

/** Two checks may see the job end at once; both answer with the first one's outcome. */
async function settleRecord(
  context: VideoCheckContext,
  record: AiModelCallOperationRecord,
  outcome: { readonly error?: string; readonly result: StoredVideoResult }
): Promise<AiModelCallOperationRecord> {
  const settled = await context.storage.aiUsage.settleModelCallOperation({
    projectId: context.projectId,
    callId: record.callId,
    status: outcome.error === undefined ? "completed" : "failed",
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    result: outcome.result as unknown as ReadonlyJsonObject,
  })
  if (!settled) {
    throw new Error(`[SixbModels] Video generation '${record.callId}' disappeared.`)
  }

  return settled
}

async function recordVideos(
  accounting: AiModelCallRecorder,
  model: VideoModel,
  record: AiModelCallOperationRecord,
  stored: StoredVideoRequest,
  metadata: VideoModelResponseMetadata,
  returnedVideos: number | undefined
): Promise<ModelCallEndEvent> {
  // Providers bill the length they were asked for, per clip they returned.
  const outputVideoMs =
    metadata.usage?.outputVideoMs ??
    (returnedVideos === 0
      ? 0
      : returnedVideos !== undefined && stored.durationSeconds !== undefined
        ? returnedVideos * stored.durationSeconds * 1_000
        : undefined)
  const usage: ModelUsage = {
    ...metadata.usage,
    ...(outputVideoMs === undefined ? {} : { outputVideoMs }),
  }
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
    dimensions: stored.dimensions,
  })
  const event: ModelCallEndEvent = {
    callId: record.callId,
    modelKind: "video",
    providerId: model.providerId,
    modelId: model.modelId,
    responseId: metadata.providerIds?.responseId ?? record.callId,
    providerIds: metadata.providerIds,
    responseModelId: metadata.responseModelId,
    usage,
    cost: metadata.reportedCost ? { status: "reported", ...metadata.reportedCost } : estimate,
    ...(metadata.reportedCost ? { estimate } : {}),
    route: metadata.route,
  }

  await accounting.onModelCallEnd(event)
  return event
}

// ── Models and replies ──────────────────────────────────────

export async function resolveVideoModel(binding: VideoModel): Promise<VideoModel> {
  assertVideoModel(binding)
  const model = binding.resolve ? await binding.resolve() : binding
  assertVideoModel(model)
  if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
    throw new TypeError(
      "[SixbModels] Resolved video model identity does not match the selected model."
    )
  }

  return model
}

/** The binding a stored generation names; checking on it needs the project to still list it. */
function catalogModel(
  catalog: ModelCatalog | undefined,
  record: AiModelCallOperationRecord
): VideoModel {
  const entry = catalog?.video?.getByRef({ provider: record.providerId, modelId: record.modelId })
  if (!entry) {
    throw new Error(
      `[SixbModels] Video model '${record.providerId}/${record.modelId}' is no longer configured, so generation '${record.callId}' cannot be checked.`
    )
  }

  return entry.model
}

function describeFailure(error: unknown): string {
  return typeof error === "string" && error.trim() ? error : "The provider failed the generation."
}

function isVideoData(value: unknown): value is VideoData {
  const video = value as Partial<VideoData> | null
  return (
    video?.data instanceof Uint8Array &&
    video.data.byteLength > 0 &&
    typeof video.mediaType === "string" &&
    /^video\/[a-z0-9.+-]+$/.test(video.mediaType)
  )
}

export function isWarnings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((warning) => typeof warning === "string")
}
