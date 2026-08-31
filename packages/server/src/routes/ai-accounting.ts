import type { SixbHostView } from "@sixb/core"
import type {
  AiAccountingAggregate,
  AiAccountingOverview,
  AiModelCallAccountingItem,
} from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AiAccountingOverviewQuerySchema,
  AiAccountingOverviewResponseSchema,
  AiModelCallAccountingListQuerySchema,
  AiModelCallAccountingListResponseSchema,
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
      agentId: agent.agentId,
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
      requestedReasoning: item.usage.requestedReasoning,
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
            ...(item.cost.priceSource === undefined
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

  return app
}
