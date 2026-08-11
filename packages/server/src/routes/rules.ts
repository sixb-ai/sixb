import type { RuleDefinition, SixbHostRuntime } from "@sixb/core"
import { deriveRuleEventDependencies } from "@sixb/core/internal/rules"
import type { RuleStateRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requireRequestSixb } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  RuleParamsSchema,
  RuleSchema,
  RuleStateListResponseSchema,
  RuleStateSchema,
  RuleStatesQuerySchema,
} from "../schemas/rules"
import { handleRouteError, parseOptionalInt, unconfiguredStorageResponse } from "../utils/http"

function serializeRule(rule: RuleDefinition): ReturnType<typeof RuleSchema.parse> {
  return RuleSchema.parse({
    ...rule,
    dependencies: deriveRuleEventDependencies(rule),
  })
}

function serializeRuleState(state: RuleStateRecord): ReturnType<typeof RuleStateSchema.parse> {
  return RuleStateSchema.parse(state)
}

export function registerRuleRoutes(app: Elysia, host: SixbHostRuntime) {
  return app
    .get(
      "/api/rules",
      (context) => {
        return requireRequestSixb(context).rules.list().map(serializeRule)
      },
      {
        response: { 200: RuleSchema.array() },
        detail: {
          summary: "List registered rules",
          tags: [OPENAPI_TAGS.rules.name],
          operationId: "listRules",
        },
      }
    )
    .get(
      "/api/rules/:ruleId",
      (context) => {
        const { params, set } = context
        const rule = requireRequestSixb(context).rules.getById(params.ruleId)
        if (!rule) {
          set.status = 404
          return { error: "Rule not found" }
        }

        return serializeRule(rule)
      },
      {
        params: RuleParamsSchema,
        response: { 200: RuleSchema, 404: ErrorResponseSchema },
        detail: {
          summary: "Get rule metadata",
          tags: [OPENAPI_TAGS.rules.name],
          operationId: "getRule",
        },
      }
    )
    .get(
      "/api/rule-states",
      async (context) => {
        const { query, set } = context
        const sixb = requireRequestSixb(context)
        try {
          const parsed = RuleStatesQuerySchema.parse(query)
          const storage = host.storage.rules
          if (!storage) {
            return unconfiguredStorageResponse(set, "Rule state storage")
          }

          const result = await sixb.rules.states.list({
            ruleId: parsed.ruleId,
            objectTypeId: parsed.objectTypeId,
            primaryId: parsed.primaryId,
            limit: parseOptionalInt(parsed.limit),
            offset: parseOptionalInt(parsed.offset),
            order: parsed.order,
          })

          return {
            states: result.states.map(serializeRuleState),
            hasMore: result.hasMore,
            total: result.total,
          }
        } catch (error) {
          return handleRouteError(error, set)
        }
      },
      {
        query: RuleStatesQuerySchema,
        response: {
          200: RuleStateListResponseSchema,
          400: ErrorResponseSchema,
          501: ErrorResponseSchema,
        },
        detail: {
          summary: "List active rule states",
          tags: [OPENAPI_TAGS.ruleStates.name],
          operationId: "listRuleStates",
        },
      }
    )
}
