import type { SixbHostView } from "@sixb/core"
import type {
  AiAccountingAggregate,
  AiAccountingOverview,
  AiModelCallAccountingItem,
  AiModelCallGroup,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { type RequestAuthState, requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AiAccountingOverviewQuerySchema,
  AiAccountingOverviewResponseSchema,
  AiModelCallAccountingListQuerySchema,
  AiModelCallAccountingListResponseSchema,
  AiModelCallGroupsQuerySchema,
  AiModelCallGroupsResponseSchema,
} from "../schemas/ai-accounting"
import { ErrorResponseSchema } from "../schemas/common"
import { handleRouteError, parseOptionalInt, unconfiguredStorageResponse } from "../utils/http"

function serializeAggregate(aggregate: AiAccountingAggregate) {
  return {
    modelCallCount: aggregate.modelCallCount,
    usage: aggregate.usage,
    costs: aggregate.costs,
  }
}

function serializeOverview(overview: AiAccountingOverview) {
  return AiAccountingOverviewResponseSchema.parse({
    range: {
      from: overview.range.from.toISOString(),
      to: overview.range.to.toISOString(),
    },
    bucket: overview.bucket,
    totals: serializeAggregate(overview.totals),
    series: overview.series.map((period) => ({
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      ...serializeAggregate(period),
    })),
    models: overview.models.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      ...serializeAggregate(model),
    })),
    agents: overview.agents.map((agent) => ({
      kind: agent.kind,
      ...(agent.kind === "workflowAgent"
        ? { workflowId: agent.workflowId, agentStepId: agent.agentStepId }
        : {}),
      ...serializeAggregate(agent),
    })),
    workflows: overview.workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      ...serializeAggregate(workflow),
    })),
  })
}

function serializeModelCall(item: AiModelCallAccountingItem) {
  return AiModelCallAccountingListResponseSchema.shape.items.element.parse({
    usage: {
      id: item.usage.id,
      executionId: item.usage.executionId,
      attempt: item.usage.attempt,
      callId: item.usage.callId,
      providerId: item.usage.providerId,
      requestedModelId: item.usage.requestedModelId,
      responseModelId: item.usage.responseModelId,
      responseId: item.usage.responseId,
      usage: item.usage.usage,
      occurredAt: item.usage.occurredAt.toISOString(),
      recordedAt: item.usage.recordedAt.toISOString(),
    },
    attribution: item.attribution,
    cost:
      item.cost === undefined
        ? undefined
        : {
            ...item.cost,
            ...(item.cost.status === "reported"
              ? {}
              : {
                  priceSource: {
                    ...item.cost.priceSource,
                    observedAt: item.cost.priceSource.observedAt.toISOString(),
                  },
                }),
            ratedAt: item.cost.ratedAt.toISOString(),
          },
    valuationStatus: item.valuationStatus,
  })
}

async function serializeGroup(
  group: AiModelCallGroup,
  host: SixbHostView,
  sixb: RequestAuthState["sixb"]
) {
  // Accounting is project-wide; conversation titles and delegation keys remain private.
  const thread =
    group.attribution?.kind === "agent" && sixb
      ? await sixb.agent.threads.getById(group.attribution.threadId)
      : null
  const childIds = thread
    ? group.executions.flatMap((execution) =>
        execution.attribution?.kind === "subagent" ? [execution.attribution.subagentRunId] : []
      )
    : []
  const children =
    childIds.length > 0
      ? ((await host.storage.agents?.runs.getByIds({ projectId: host.id, ids: childIds })) ?? [])
      : []
  const labels = new Map(
    children.flatMap((run) =>
      run.kind === "subagent" ? [[run.executionId, run.spawnKey] as const] : []
    )
  )
  return {
    ...group,
    label: thread?.title,
    canOpenThread: thread !== null,
    firstCallAt: group.firstCallAt.toISOString(),
    lastCallAt: group.lastCallAt.toISOString(),
    executions: group.executions.map((execution) => ({
      ...execution,
      label: labels.get(execution.executionId),
      firstCallAt: execution.firstCallAt.toISOString(),
      lastCallAt: execution.lastCallAt.toISOString(),
    })),
  }
}

export function registerAiAccountingRoutes(app: Elysia, host: SixbHostView) {
  app.get(
    "/api/ai/accounting/overview",
    async ({ query, set }) => {
      try {
        const parsed = AiAccountingOverviewQuerySchema.parse(query)
        const storage = host.storage.aiCosts
        if (!storage) return unconfiguredStorageResponse(set, "AI cost storage")
        const overview = await storage.queryProjectOverview({
          projectId: host.id,
          from: new Date(parsed.from),
          to: new Date(parsed.to),
          bucket: parsed.bucket,
          providerId: parsed.providerId,
          modelId: parsed.modelId,
        })
        return serializeOverview(overview)
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      query: AiAccountingOverviewQuerySchema,
      response: {
        200: AiAccountingOverviewResponseSchema,
        400: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Get project AI usage and cost analytics",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "getAiAccountingOverview",
      },
    }
  )

  app.get(
    "/api/ai/model-calls",
    async ({ query, set }) => {
      try {
        const parsed = AiModelCallAccountingListQuerySchema.parse(query)
        const storage = host.storage.aiCosts
        if (!storage) return unconfiguredStorageResponse(set, "AI cost storage")
        const result = await storage.listModelCalls({
          projectId: host.id,
          from: new Date(parsed.from),
          to: new Date(parsed.to),
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          executionId: parsed.executionId,
          valuationStatus: parsed.valuationStatus,
          limit: parseOptionalInt(parsed.limit),
          offset: parseOptionalInt(parsed.offset),
        })
        const items = result.items.map(serializeModelCall)
        return AiModelCallAccountingListResponseSchema.parse({
          items,
          hasMore: result.hasMore,
          total: result.total,
        })
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      query: AiModelCallAccountingListQuerySchema,
      response: {
        200: AiModelCallAccountingListResponseSchema,
        400: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "List project AI model-call accounting records",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "listAiModelCalls",
      },
    }
  )

  app.get(
    "/api/ai/model-call-groups",
    async (context) => {
      const { query, set } = context
      try {
        const parsed = AiModelCallGroupsQuerySchema.parse(query)
        const storage = host.storage.aiCosts
        if (!storage) return unconfiguredStorageResponse(set, "AI cost storage")
        const result = await storage.listModelCallGroups({
          projectId: host.id,
          from: new Date(parsed.from),
          to: new Date(parsed.to),
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          valuationStatus: parsed.valuationStatus,
          limit: parseOptionalInt(parsed.limit),
          offset: parseOptionalInt(parsed.offset),
        })
        const { sixb } = requestAuthState(context)
        return AiModelCallGroupsResponseSchema.parse({
          ...result,
          items: await Promise.all(result.items.map((group) => serializeGroup(group, host, sixb))),
        })
      } catch (error) {
        return handleRouteError(error, set)
      }
    },
    {
      query: AiModelCallGroupsQuerySchema,
      response: {
        200: AiModelCallGroupsResponseSchema,
        400: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "List AI model calls grouped by initiating execution",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "listAiModelCallGroups",
      },
    }
  )

  return app
}
