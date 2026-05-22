import { randomUUID } from "node:crypto"
import type {
  PipelineDefinition,
  PipelineRunRecord,
  PipelineStepExecutor,
  PipelineStepRunRecord,
} from "@pario/core"
import type { Elysia } from "elysia"
import { PARIO_CSRF_SECURITY_REQUIREMENT } from "../openapi/security"
import type { ParioServerRuntime } from "../runtime"
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
import { handleRouteError, parseDate, parseOptionalInt, toIsoString } from "../utils/http"

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
  pario: ParioServerRuntime,
  pipelineId: string
): Promise<ReturnType<typeof serializePipelineRun> | null> {
  if (!pario.storage.pipelineRuns) {
    return null
  }

  const result = await pario.storage.pipelineRuns.list({
    projectId: pario.id,
    pipelineId,
    limit: 1,
    order: "desc",
  })

  const [latest] = result.runs
  return latest ? serializePipelineRun(latest) : null
}

async function serializePipeline(
  pario: ParioServerRuntime,
  pipeline: PipelineDefinition
): Promise<ReturnType<typeof PipelineSchema.parse>> {
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
    latestRun: await getLatestPipelineRun(pario, pipeline.id),
  })
}

export function registerPipelineRoutes(app: Elysia, pario: ParioServerRuntime) {
  return app
    .get(
      "/api/pipelines",
      async () => {
        return await Promise.all(
          pario.getPipelineDefinitions().map((pipeline) => serializePipeline(pario, pipeline))
        )
      },
      {
        response: { 200: PipelineSchema.array() },
        detail: {
          summary: "List registered pipelines",
          tags: ["Pipelines"],
          operationId: "listPipelines",
        },
      }
    )
    .get(
      "/api/pipelines/:pipelineId",
      async ({ params, set }) => {
        const pipeline = pario.getPipelineById(params.pipelineId)
        if (!pipeline) {
          set.status = 404
          return { error: "Pipeline not found" }
        }

        return await serializePipeline(pario, pipeline)
      },
      {
        params: PipelineParamsSchema,
        response: { 200: PipelineSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get pipeline metadata",
          tags: ["Pipelines"],
          operationId: "getPipeline",
        },
      }
    )
    .get(
      "/api/pipeline-runs",
      async ({ query, set }) => {
        try {
          const parsed = PipelineRunsQuerySchema.parse(query)
          const storage = pario.storage.pipelineRuns
          if (!storage) {
            return {
              runs: [],
              hasMore: false,
              total: 0,
            }
          }

          const result = await storage.list({
            projectId: pario.id,
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
        response: { 200: PipelineRunListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List pipeline run history",
          tags: ["Pipelines"],
          operationId: "listPipelineRuns",
        },
      }
    )
    .get(
      "/api/pipeline-runs/:runId",
      async ({ params, set }) => {
        try {
          const storage = pario.storage.pipelineRuns
          if (!storage) {
            set.status = 400
            return { error: "Pipeline run storage is not configured" }
          }

          const run = await storage.getById({
            projectId: pario.id,
            id: params.runId,
          })
          if (!run) {
            set.status = 404
            return { error: "Pipeline run not found" }
          }

          const steps = await storage.listSteps({
            projectId: pario.id,
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
        },
        detail: {
          summary: "Get pipeline run detail",
          tags: ["Pipelines"],
          operationId: "getPipelineRun",
        },
      }
    )
    .post(
      "/api/pipelines/:pipelineId/runs",
      async ({ params, set }) => {
        try {
          const pipeline = pario.getPipelineById(params.pipelineId)
          if (!pipeline) {
            set.status = 404
            return { error: "Pipeline not found" }
          }

          if (!pario.storage.pipelineRuns) {
            set.status = 400
            return { error: "Pipeline run storage is not configured" }
          }

          const runId = `run_${randomUUID()}`
          const queuedAt = new Date().toISOString()
          const [job] = await pario.queues.pipelines.enqueue({
            projectId: pario.id,
            jobs: [
              {
                type: "pipeline.run.requested",
                payload: {
                  pipelineId: pipeline.id,
                  runId,
                },
              },
            ],
          })

          set.status = 202
          return {
            runId,
            jobId: job?.id ?? "",
            pipelineId: pipeline.id,
            queuedAt,
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
          404: ErrorResponseSchema,
        },
        detail: {
          summary: "Request a pipeline run",
          tags: ["Pipelines"],
          operationId: "requestPipelineRun",
          security: PARIO_CSRF_SECURITY_REQUIREMENT,
        },
      }
    )
}
