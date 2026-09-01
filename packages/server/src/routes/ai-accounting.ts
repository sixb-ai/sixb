import type { SixbHostView } from "@sixb/core"
import type {
  AiAccountingAggregate,
  AiAccountingOverview,
  AiLimitPolicy,
  AiLimitPolicyStatus,
  AiModelCallAccountingItem,
} from "@sixb/core/storage"
import { AiLimitStorageError } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { bearerSecurityRequirement } from "../auth/access-token-boundary"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AiAccountingOverviewQuerySchema,
  AiAccountingOverviewResponseSchema,
  AiModelCallAccountingListQuerySchema,
  AiModelCallAccountingListResponseSchema,
} from "../schemas/ai-accounting"
import {
  AiLimitListQuerySchema,
  AiLimitPolicyListResponseSchema,
  AiLimitPolicyParamsSchema,
  AiLimitPolicySchema,
  AiLimitPolicyStatusListResponseSchema,
  AiLimitStatusQuerySchema,
  AiLimitSubjectOptionsResponseSchema,
  CreateAiLimitPolicyBodySchema,
  UpdateAiLimitPolicyBodySchema,
} from "../schemas/ai-limits"
import { ErrorResponseSchema, SuccessResponseSchema } from "../schemas/common"
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
            priceSource: {
              ...item.cost.priceSource,
              observedAt: item.cost.priceSource.observedAt.toISOString(),
            },
            ratedAt: item.cost.ratedAt.toISOString(),
          },
    valuationStatus: item.valuationStatus,
  })
}

function serializeLimitPolicy(policy: AiLimitPolicy) {
  return AiLimitPolicySchema.parse({
    id: policy.id,
    subject: policy.subject,
    limit: policy.limit,
    period: policy.period,
    enabled: policy.enabled,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  })
}

function serializeLimitStatus(status: AiLimitPolicyStatus) {
  return {
    policy: serializeLimitPolicy(status.policy),
    period: {
      kind: status.period.kind,
      start: status.period.start.toISOString(),
      end: status.period.end.toISOString(),
      resetAt: status.period.resetAt.toISOString(),
    },
    consumption: status.consumption,
    accountingStatus: status.accountingStatus,
    exhausted: status.exhausted,
    orphaned: status.orphaned,
  }
}

function includeDisabled(value: "true" | "false" | undefined): boolean {
  return value === "true"
}

function handleAiLimitRouteError(error: unknown, set: { status?: number | string }) {
  if (error instanceof AiLimitStorageError) {
    if (error.code === "duplicate_policy") set.status = 409
    else if (error.code === "missing_policy") set.status = 404
    else set.status = 400
    return { error: error.message }
  }
  return handleRouteError(error, set)
}

export function registerAiAccountingRoutes(app: Elysia, _host: SixbHostView) {
  app.get(
    "/api/ai/accounting/overview",
    async (context) => {
      const { query, set } = context
      try {
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertObservable()
        const parsed = AiAccountingOverviewQuerySchema.parse(query)
        if (!sixb.aiUsage.accountingConfigured) {
          return unconfiguredStorageResponse(set, "AI cost storage")
        }
        const overview = await sixb.aiUsage.queryOverview({
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
        403: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Get project AI usage and cost analytics",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "getAiAccountingOverview",
        security: bearerSecurityRequirement("getAiAccountingOverview"),
      },
    }
  )

  app.get(
    "/api/ai/model-calls",
    async (context) => {
      const { query, set } = context
      try {
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertObservable()
        const parsed = AiModelCallAccountingListQuerySchema.parse(query)
        if (!sixb.aiUsage.accountingConfigured) {
          return unconfiguredStorageResponse(set, "AI cost storage")
        }
        const result = await sixb.aiUsage.listModelCalls({
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
        403: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "List project AI model-call accounting records",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "listAiModelCalls",
        security: bearerSecurityRequirement("listAiModelCalls"),
      },
    }
  )

  app.get(
    "/api/ai/limits",
    async (context) => {
      const { query, set } = context
      try {
        const sixb = requireRequestSixb(context)
        if (!sixb.aiUsage.limitsConfigured) {
          return unconfiguredStorageResponse(set, "AI limit storage")
        }
        const parsed = AiLimitListQuerySchema.parse(query)
        const items = await sixb.aiUsage.listLimitPolicies({
          includeDisabled: includeDisabled(parsed.includeDisabled),
        })
        return AiLimitPolicyListResponseSchema.parse({
          items: items.map(serializeLimitPolicy),
          capabilities: { manage: sixb.aiUsage.canManageLimits() },
        })
      } catch (error) {
        return handleAiLimitRouteError(error, set)
      }
    },
    {
      query: AiLimitListQuerySchema,
      response: {
        200: AiLimitPolicyListResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "List project AI usage-limit policies",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "listAiLimitPolicies",
        security: bearerSecurityRequirement("listAiLimitPolicies"),
      },
    }
  )

  app.get(
    "/api/ai/limits/status",
    async (context) => {
      const { query, set } = context
      try {
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertObservable()
        if (!sixb.aiUsage.limitsConfigured) {
          return unconfiguredStorageResponse(set, "AI limit storage")
        }
        const parsed = AiLimitStatusQuerySchema.parse(query)
        const items = await sixb.aiUsage.listLimitStatuses({
          includeDisabled: includeDisabled(parsed.includeDisabled),
        })
        return AiLimitPolicyStatusListResponseSchema.parse({
          items: items.map(serializeLimitStatus),
          capabilities: { manage: sixb.aiUsage.canManageLimits() },
        })
      } catch (error) {
        return handleAiLimitRouteError(error, set)
      }
    },
    {
      query: AiLimitStatusQuerySchema,
      response: {
        200: AiLimitPolicyStatusListResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Get current project AI usage-limit status",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "getAiLimitStatus",
        security: bearerSecurityRequirement("getAiLimitStatus"),
      },
    }
  )

  app.get(
    "/api/ai/limits/subjects",
    async (context) => {
      const { set } = context
      try {
        const sixb = requireRequestSixb(context)
        return AiLimitSubjectOptionsResponseSchema.parse(
          await sixb.aiUsage.listLimitSubjectOptions()
        )
      } catch (error) {
        return handleAiLimitRouteError(error, set)
      }
    },
    {
      response: {
        200: AiLimitSubjectOptionsResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
      },
      detail: {
        summary: "Get selectable AI usage-limit subjects",
        description:
          "Lists registered groups and auth principals available for AI usage-limit policies.",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "getAiLimitSubjectOptions",
        security: bearerSecurityRequirement("getAiLimitSubjectOptions"),
      },
    }
  )

  app.post(
    "/api/ai/limits",
    async (context) => {
      const { body, set } = context
      try {
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertManageable()
        if (!sixb.aiUsage.limitsConfigured) {
          return unconfiguredStorageResponse(set, "AI limit storage")
        }
        const parsed = CreateAiLimitPolicyBodySchema.parse(body)
        return serializeLimitPolicy(await sixb.aiUsage.createLimitPolicy(parsed))
      } catch (error) {
        return handleAiLimitRouteError(error, set)
      }
    },
    {
      body: CreateAiLimitPolicyBodySchema,
      response: {
        200: AiLimitPolicySchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        409: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Create an AI usage-limit policy",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "createAiLimitPolicy",
        security: bearerSecurityRequirement("createAiLimitPolicy"),
      },
    }
  )

  app.put(
    "/api/ai/limits/:limitId",
    async (context) => {
      const { params, body, set } = context
      try {
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertManageable()
        if (!sixb.aiUsage.limitsConfigured) {
          return unconfiguredStorageResponse(set, "AI limit storage")
        }
        const { limitId } = AiLimitPolicyParamsSchema.parse(params)
        const parsed = UpdateAiLimitPolicyBodySchema.parse(body)
        return serializeLimitPolicy(
          await sixb.aiUsage.updateLimitPolicy({ id: limitId, ...parsed })
        )
      } catch (error) {
        return handleAiLimitRouteError(error, set)
      }
    },
    {
      params: AiLimitPolicyParamsSchema,
      body: UpdateAiLimitPolicyBodySchema,
      response: {
        200: AiLimitPolicySchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Update an AI usage-limit policy",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "updateAiLimitPolicy",
        security: bearerSecurityRequirement("updateAiLimitPolicy"),
      },
    }
  )

  app.delete(
    "/api/ai/limits/:limitId",
    async (context) => {
      const { params, set } = context
      try {
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertManageable()
        if (!sixb.aiUsage.limitsConfigured) {
          return unconfiguredStorageResponse(set, "AI limit storage")
        }
        const { limitId } = AiLimitPolicyParamsSchema.parse(params)
        if (!(await sixb.aiUsage.deleteLimitPolicy(limitId))) {
          set.status = 404
          return { error: "AI usage-limit policy not found." }
        }
        return { success: true }
      } catch (error) {
        return handleAiLimitRouteError(error, set)
      }
    },
    {
      params: AiLimitPolicyParamsSchema,
      response: {
        200: SuccessResponseSchema,
        400: ErrorResponseSchema,
        403: ErrorResponseSchema,
        404: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "Delete an AI usage-limit policy",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "deleteAiLimitPolicy",
        security: bearerSecurityRequirement("deleteAiLimitPolicy"),
      },
    }
  )

  return app
}
