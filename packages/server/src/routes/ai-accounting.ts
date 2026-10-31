import type { AgentMessagePart, SixbHostView } from "@sixb/core"
import type {
  AiAccountingAggregate,
  AiAccountingFilters,
  AiAccountingOverview,
  AiAccountingRequester,
  AiLimitPolicy,
  AiLimitPolicyStatus,
  AiModelCallAccountingItem,
  AiModelCallCostRecord,
  AiModelCallGroup,
} from "@sixb/core/storage"
import { AiLimitStorageError } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { accessTokenSecurityRequirement } from "../auth/access-token-boundary"
import type { RequestAuthState } from "../auth/scope"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import {
  AiAccountingOverviewQuerySchema,
  AiAccountingOverviewResponseSchema,
  AiModelCallAccountingListQuerySchema,
  AiModelCallAccountingListResponseSchema,
  AiModelCallGroupsQuerySchema,
  AiModelCallGroupsResponseSchema,
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
    usageCoverage: aggregate.usageCoverage,
    costs: aggregate.costs,
  }
}

/** The person, source and kind filters a query names, as the storage reads them. */
function accountingFilters(parsed: {
  readonly person?: string
  readonly source?: string
  readonly kind?: AiAccountingFilters["modelKind"]
}): Partial<Pick<AiAccountingFilters, "requester" | "source" | "modelKind">> {
  const colon = parsed.person?.indexOf(":") ?? -1
  return {
    ...(parsed.person === undefined
      ? {}
      : {
          requester:
            parsed.person === "none"
              ? ("none" as const)
              : {
                  type: parsed.person.slice(0, colon) as AiAccountingRequester["type"],
                  id: parsed.person.slice(colon + 1),
                },
        }),
    ...(parsed.source === undefined
      ? {}
      : {
          source: parsed.source.startsWith("workflow:")
            ? { kind: "workflow" as const, workflowId: parsed.source.slice("workflow:".length) }
            : { kind: parsed.source as "agent" | "action" | "workflow" | "other" },
        }),
    ...(parsed.kind === undefined ? {} : { modelKind: parsed.kind }),
  }
}

type RequesterDetails = ReadonlyMap<string, { readonly name?: string; readonly email?: string }>

const requesterKey = (requester: AiAccountingRequester) => `${requester.type}:${requester.id}`

/** Each requester's name and email, read once for the page they are on. */
async function requesterDetails(
  host: SixbHostView,
  requesters: readonly (AiAccountingRequester | undefined)[]
): Promise<RequesterDetails> {
  const auth = host.storage.auth
  const details = new Map<string, { name?: string; email?: string }>()
  if (!auth) return details
  const unique = [
    ...new Map(
      requesters.flatMap((requester) => (requester ? [[requesterKey(requester), requester]] : []))
    ).values(),
  ]
  const userIds = unique.flatMap((requester) => (requester.type === "user" ? [requester.id] : []))
  if (userIds.length > 0) {
    for (const user of await auth.users.getByIds({ projectId: host.id, ids: userIds })) {
      details.set(`user:${user.id}`, {
        ...(user.displayName ? { name: user.displayName } : {}),
        email: user.email,
      })
    }
  }
  for (const requester of unique) {
    if (requester.type !== "serviceAccount") continue
    const account = await auth.serviceAccounts.getById({ projectId: host.id, id: requester.id })
    if (account) details.set(requesterKey(requester), { name: account.name })
  }
  return details
}

function serializeRequester(
  requester: AiAccountingRequester | undefined,
  details: RequesterDetails
) {
  return requester ? { ...requester, ...details.get(requesterKey(requester)) } : undefined
}

function serializeOverview(overview: AiAccountingOverview, details: RequesterDetails) {
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
    modelSeries: overview.modelSeries.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      series: model.series.map((period) => ({
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        ...serializeAggregate(period),
      })),
    })),
    models: overview.models.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      ...serializeAggregate(model),
    })),
    people: overview.people.map((person) => ({
      ...(person.requester ? { requester: serializeRequester(person.requester, details) } : {}),
      ...serializeAggregate(person),
    })),
    kinds: overview.kinds.map((kind) => ({
      ...(kind.modelKind === undefined ? {} : { modelKind: kind.modelKind }),
      ...serializeAggregate(kind),
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

function serializeCost(cost: AiModelCallCostRecord) {
  return {
    ...cost,
    source:
      cost.status !== "rated"
        ? "unknown"
        : cost.priceSource.sourceId === "provider-reported"
          ? "provider"
          : cost.priceSource.sourceId === "model-rate-card"
            ? "estimate"
            : "unknown",
    ...(cost.priceSource === undefined
      ? {}
      : {
          priceSource: {
            ...cost.priceSource,
            observedAt: cost.priceSource.observedAt.toISOString(),
          },
        }),
    ratedAt: cost.ratedAt.toISOString(),
  }
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
      modelKind: item.usage.modelKind,
      providerIds: item.usage.providerIds ?? null,
      requestedReasoning: item.usage.requestedReasoning,
      responseModelId: item.usage.responseModelId,
      responseId: item.usage.responseId,
      usage: item.usage.usage,
      occurredAt: item.usage.occurredAt.toISOString(),
      recordedAt: item.usage.recordedAt.toISOString(),
    },
    attribution: item.attribution,
    cost: item.cost === undefined ? undefined : serializeCost(item.cost),
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

async function serializeGroup(
  group: AiModelCallGroup,
  host: SixbHostView,
  sixb: RequestAuthState["sixb"],
  details: RequesterDetails
) {
  // Accounting is project-wide; conversation titles and delegation keys remain private.
  const thread =
    group.attribution?.kind === "agent" && sixb
      ? await sixb.agent.threads.getById(group.attribution.threadId)
      : null
  // The conversation's turns and sub-agents, read together, for the sub-agents' names and what
  // each turn was asked.
  const agents = host.storage.agents
  const runIds = thread
    ? group.executions.flatMap((execution) =>
        execution.attribution?.kind === "agent"
          ? [execution.attribution.agentRunId]
          : execution.attribution?.kind === "subagent"
            ? [execution.attribution.subagentRunId]
            : []
      )
    : []
  const runs =
    agents && runIds.length > 0
      ? await agents.runs.getByIds({ projectId: host.id, ids: runIds })
      : []
  const labels = new Map(
    runs.flatMap((run) =>
      run.kind === "subagent" ? [[run.executionId, run.spawnKey] as const] : []
    )
  )
  const prompts = new Map(
    agents
      ? await Promise.all(
          runs.flatMap((run) =>
            run.kind === "conversation"
              ? [
                  agents.messages
                    .getById({ projectId: host.id, id: run.triggerMessageId })
                    .then((message) => [run.executionId, message && promptOf(message)] as const),
                ]
              : []
          )
        )
      : []
  )
  const { requester, ...rest } = group
  return {
    ...rest,
    ...(requester ? { requester: serializeRequester(requester, details) } : {}),
    label: thread?.title,
    canOpenThread: thread !== null,
    firstCallAt: group.firstCallAt.toISOString(),
    lastCallAt: group.lastCallAt.toISOString(),
    executions: group.executions.map((execution) => ({
      ...execution,
      label: labels.get(execution.executionId),
      prompt: prompts.get(execution.executionId) ?? undefined,
      firstCallAt: execution.firstCallAt.toISOString(),
      lastCallAt: execution.lastCallAt.toISOString(),
    })),
  }
}

/** The opening of the message that started a turn, on one line. */
function promptOf(message: { readonly parts: readonly AgentMessagePart[] }): string | undefined {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (!text) return undefined
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

export function registerAiAccountingRoutes(app: Elysia, host: SixbHostView) {
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
          ...accountingFilters(parsed),
        })
        const details = await requesterDetails(
          host,
          overview.people.map((person) => person.requester)
        )
        return serializeOverview(overview, details)
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
        security: accessTokenSecurityRequirement("getAiAccountingOverview"),
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
          ...accountingFilters(parsed),
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
        security: accessTokenSecurityRequirement("listAiModelCalls"),
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
        security: accessTokenSecurityRequirement("listAiLimitPolicies"),
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
        security: accessTokenSecurityRequirement("getAiLimitStatus"),
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
        security: accessTokenSecurityRequirement("getAiLimitSubjectOptions"),
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
        security: accessTokenSecurityRequirement("createAiLimitPolicy"),
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
        security: accessTokenSecurityRequirement("updateAiLimitPolicy"),
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
        security: accessTokenSecurityRequirement("deleteAiLimitPolicy"),
      },
    }
  )

  app.get(
    "/api/ai/model-call-groups",
    async (context) => {
      const { query, set } = context
      try {
        const parsed = AiModelCallGroupsQuerySchema.parse(query)
        const sixb = requireRequestSixb(context)
        sixb.aiUsage.assertObservable()
        if (!sixb.aiUsage.accountingConfigured)
          return unconfiguredStorageResponse(set, "AI cost storage")
        const result = await sixb.aiUsage.listModelCallGroups({
          from: new Date(parsed.from),
          to: new Date(parsed.to),
          providerId: parsed.providerId,
          modelId: parsed.modelId,
          ...accountingFilters(parsed),
          valuationStatus: parsed.valuationStatus,
          sort: parsed.sort,
          limit: parseOptionalInt(parsed.limit),
          offset: parseOptionalInt(parsed.offset),
        })
        const details = await requesterDetails(
          host,
          result.items.map((group) => group.requester)
        )
        return AiModelCallGroupsResponseSchema.parse({
          ...result,
          items: await Promise.all(
            result.items.map((group) => serializeGroup(group, host, sixb, details))
          ),
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
        403: ErrorResponseSchema,
        501: ErrorResponseSchema,
      },
      detail: {
        summary: "List AI model calls grouped by initiating execution",
        tags: [OPENAPI_TAGS.aiAccounting.name],
        operationId: "listAiModelCallGroups",
        security: accessTokenSecurityRequirement("listAiModelCallGroups"),
      },
    }
  )

  return app
}
