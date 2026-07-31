import type { OntologySource, PipelineDefinition, PipelineStepExecutor, Sixb } from "@sixb/core"
import { canViewPipelineRun } from "@sixb/core/internal/authorization"
import type { PipelineRunRecord, PipelineStepRunRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
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
  sixb: Sixb<readonly OntologySource[]>,
  pipelineId: string
): Promise<SerializedPipelineRun | null> {
  if (!sixb.storage.pipelineRuns) {
    return null
  }

  const storage = sixb.storage.pipelineRuns
  const result = await storage.listLatestByPipelineIds({
    projectId: sixb.id,
    pipelineIds: [pipelineId],
  })

  const [latest] = result.runs
  return latest ? serializePipelineRun(latest) : null
}

async function getLatestPipelineRuns(
  sixb: Sixb<readonly OntologySource[]>,
  pipelineIds: readonly string[]
): Promise<Map<string, SerializedPipelineRun>> {
  const storage = sixb.storage.pipelineRuns
  if (!storage || pipelineIds.length === 0) {
    return new Map()
  }

  const result = await storage.listLatestByPipelineIds({
    projectId: sixb.id,
    pipelineIds,
  })

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

export function registerPipelineRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/pipelines",
      async (context) => {
        const { scoped } = requestAuthState(context)
        const pipelines = scoped ? scoped.listPipelines() : sixb.listPipelines()
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
        const { scoped } = requestAuthState(context)
        const pipeline = scoped
          ? scoped.getPipelineById(params.pipelineId)
          : sixb.getPipelineById(params.pipelineId)
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
        const { authz } = requestAuthState(context)
        try {
          const parsed = PipelineRunsQuerySchema.parse(query)
          const storage = sixb.storage.pipelineRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Pipeline run storage")
          }

          // Scope to runnable pipelines the same way workflow run history does:
          // pass the grant allowlist alongside any explicit pipelineId and let
          // storage AND them. An ungranted pipelineId yields an empty
          // intersection, and an empty allowlist short-circuits to no rows.
          const pipelineIds = authz ? [...authz.grants["run:pipeline"]] : undefined
          const result = await storage.list({
            projectId: sixb.id,
            pipelineId: parsed.pipelineId,
            pipelineIds,
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
        const { authz } = requestAuthState(context)
        try {
          const storage = sixb.storage.pipelineRuns
          if (!storage) {
            return unconfiguredStorageResponse(set, "Pipeline run storage")
          }

          const run = await storage.getById({
            projectId: sixb.id,
            id: params.runId,
          })
          // A run the principal cannot run is hidden as 404, never surfaced as a
          // distinct 403, mirroring the catalog and run-history routes.
          if (!run || !canViewPipelineRun(authz, run)) {
            set.status = 404
            return { error: "Pipeline run not found" }
          }

          const steps = await storage.listSteps({
            projectId: sixb.id,
            pipelineRunId: run.id,
            order: "asc",
          })

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
        const { scoped } = requestAuthState(context)
        try {
          const pipeline = sixb.getPipelineById(params.pipelineId)
          if (!pipeline) {
            set.status = 404
            return { error: "Pipeline not found" }
          }

          const result = scoped
            ? await scoped.requestPipelineRun({ pipelineId: pipeline.id })
            : await sixb.requestPipelineRun({ pipelineId: pipeline.id })

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
