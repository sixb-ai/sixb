import type { PipelineDefinition, PipelineStepExecutor, SixbHostRuntime } from "@sixb/core"
import type { PipelineRunRecord, PipelineStepRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { SIXB_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  PipelineParamsSchema,
  PipelineRunDetailResponseSchema,
  PipelineRunListResponseSchema,
  PipelineRunParamsSchema,
  PipelineRunsQuerySchema,
  PipelineSchema,
  RequestPipelineRunResponseSchema,
} from "../schemas/pipelines"
import {
  handleRouteError,
  parseDate,
  parseOptionalInt,
  toIsoString,
  unconfiguredStorageResponse,
} from "../utils/http"

function serializePipelineRun(run: PipelineRunRecord) {
  return {
    id: run.id,
    projectId: run.projectId,
    pipelineId: run.pipelineId,
    status: run.status,
    startedAt: toIsoString(run.startedAt),
    finishedAt: run.finishedAt ? toIsoString(run.finishedAt) : undefined,
    output: run.output,
    error: run.error,
  }
}

type SerializedPipelineRun = ReturnType<typeof serializePipelineRun>

function serializePipelineStepRun(step: PipelineStepRunRecord) {
  return {
    id: step.id,
    projectId: step.projectId,
    pipelineRunId: step.pipelineRunId,
    pipelineId: step.pipelineId,
    stepId: step.stepId,
    datasetId: step.datasetId,
    mode: step.mode,
    status: step.status,
    startedAt: toIsoString(step.startedAt),
    finishedAt: step.finishedAt ? toIsoString(step.finishedAt) : undefined,
    inputs: step.inputs,
    output: step.output,
    rowsWritten: step.rowsWritten,
    error: step.error,
  }
}

function serializeExecutor(executor: PipelineStepExecutor) {
  switch (executor.kind) {
    case "sql":
      return {
        kind: "sql" as const,
        dialect: executor.dialect,
      }
    case "run":
      return {
        kind: "run" as const,
      }
  }
}

async function getLatestPipelineRun(
  sixb: ReturnType<typeof requireRequestSixb>,
  pipelineId: string
): Promise<SerializedPipelineRun | null> {
  const result = await sixb.pipelines.runs.listLatest([pipelineId])

  const [latest] = result.runs
  return latest ? serializePipelineRun(latest) : null
}

async function getLatestPipelineRuns(
  sixb: ReturnType<typeof requireRequestSixb>,
  pipelineIds: readonly string[]
): Promise<Map<string, SerializedPipelineRun>> {
  if (pipelineIds.length === 0) {
    return new Map()
  }

  const result = await sixb.pipelines.runs.listLatest(pipelineIds)

  return new Map(result.runs.map((run) => [run.pipelineId, serializePipelineRun(run)]))
}

function serializePipeline(
  pipeline: PipelineDefinition,
  latestRun: SerializedPipelineRun | null
): ReturnType<typeof PipelineSchema.parse> {
  return PipelineSchema.parse({
    id: pipeline.id,
    triggers: pipeline.triggers,
    graph: {
      kind: pipeline.graph.kind,
      nodes: pipeline.graph.nodes.map((node) => ({
        kind: node.kind,
        step: {
          id: node.step.id,
          mode: node.step.mode,
          executor: serializeExecutor(node.step.executor),
          inputs: Object.entries(node.step.inputs).map(([name, dataset]) => ({
            name,
            dataset,
          })),
          output: node.step.output,
        },
      })),
    },
    latestRun,
  })
}

export function registerPipelineRoutes(app: Elysia, host: SixbHostRuntime) {
  return app
    .get(
      "/api/pipelines",
      async (context) => {
        const sixb = requireRequestSixb(context)
        const pipelines = sixb.pipelines.list()
        const latestRuns = await getLatestPipelineRuns(
          sixb,
          pipelines.map((pipeline) => pipeline.id)
        )

        return pipelines.map((pipeline) =>
          serializePipeline(pipeline, latestRuns.get(pipeline.id) ?? null)
        )
      },
      {
        response: { 200: PipelineSchema.array() },
        detail: {
          summary: "List registered pipelines",
          tags: [OPENAPI_TAGS.pipelines.name],
          operationId: "listPipelines",
        },
      }
    )
    .get(
      "/api/pipelines/:pipelineId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        const pipeline = sixb.pipelines.getById(params.pipelineId)
        if (!pipeline) {
          set.status = 404
          return { error: "Pipeline not found" }
        }

        return serializePipeline(pipeline, await getLatestPipelineRun(sixb, pipeline.id))
      },
      {
        params: PipelineParamsSchema,
        response: { 200: PipelineSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get pipeline metadata",
          tags: [OPENAPI_TAGS.pipelines.name],
          operationId: "getPipeline",
        },
      }
    )
    .get(
      "/api/pipeline-runs",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const parsed = PipelineRunsQuerySchema.parse(query)
          const storage = host.storage.pipelineRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Pipeline run storage")
          }

          const result = await sixb.pipelines.runs.list({
            pipelineId: parsed.pipelineId,
            statuses: parsed.status ? [parsed.status] : undefined,
            startedAfter: parseDate(parsed.startedAfter),
            startedBefore: parseDate(parsed.startedBefore),
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return {
            runs: result.runs.map(serializePipelineRun),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: PipelineRunsQuerySchema,
        response: {
          200: PipelineRunListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List pipeline run history",
          tags: [OPENAPI_TAGS.pipelineRuns.name],
          operationId: "listPipelineRuns",
        },
      }
    )
    .get(
      "/api/pipeline-runs/:runId",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const storage = host.storage.pipelineRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Pipeline run storage")
          }

          const run = await sixb.pipelines.runs.getById(params.runId)
          if (!run) {
            set.status = 404
            return { error: "Pipeline run not found" }
          }

          const steps = await sixb.pipelines.runs.listSteps(run.id, { order: "asc" })
          if (!steps) {
            set.status = 404
            return { error: "Pipeline run not found" }
          }

          return PipelineRunDetailResponseSchema.parse({
            run: serializePipelineRun(run),
            steps: steps.steps.map(serializePipelineStepRun),
          })
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: PipelineRunParamsSchema,
        response: {
          200: PipelineRunDetailResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "Get pipeline run detail",
          tags: [OPENAPI_TAGS.pipelineRuns.name],
          operationId: "getPipelineRun",
        },
      }
    )
    .post(
      "/api/pipelines/:pipelineId/runs",
      async (context) => {
        const { params, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const result = await sixb.pipelines.request({ pipelineId: params.pipelineId })

          set.status = 202
          return {
            runId: result.runId,
            jobId: result.jobId ?? "",
            pipelineId: result.pipelineId,
            queuedAt: result.queuedAt,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        params: PipelineParamsSchema,
        response: {
          202: RequestPipelineRunResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request a pipeline run",
          tags: [OPENAPI_TAGS.pipelineRuns.name],
          operationId: "requestPipelineRun",
          security: SIXB_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
