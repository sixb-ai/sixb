import {
  deriveRuleEventDependencies,
  isAllowed,
  type OntologySource,
  type RuleDefinition,
  type Sixb,
} from "@sixb/core"
import type { RuleStateRecord } from "@sixb/core/storage"
import type { Elysia } from "elysia"
import { requestAuthState } from "../auth/scope"
import { OPENAPI_TAGS } from "../openapi/tags"
import { ErrorResponseSchema } from "../schemas/common"
import {
  RuleParamsSchema,
  RuleSchema,
  RuleStateListResponseSchema,
  RuleStateSchema,
  RuleStatesQuerySchema,
} from "../schemas/rules"
import { handleRouteError, parseOptionalInt } from "../utils/http"

function serializeRule(rule: RuleDefinition): ReturnType<typeof RuleSchema.parse> {
  return RuleSchema.parse({
    ...rule,
    dependencies: deriveRuleEventDependencies(rule),
  })
}

function serializeRuleState(state: RuleStateRecord): ReturnType<typeof RuleStateSchema.parse> {
  return RuleStateSchema.parse(state)
}

export function registerRuleRoutes(app: Elysia, sixb: Sixb<readonly OntologySource[]>) {
  return app
    .get(
      "/api/rules",
      () => {
        return sixb.getRuleDefinitions().map(serializeRule)
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
      ({ params, set }) => {
        const rule = sixb.getRuleById(params.ruleId)
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
        const { authz } = requestAuthState(context)
        try {
          const parsed = RuleStatesQuerySchema.parse(query)
          const storage = sixb.storage.rules
          if (!storage) {
            return {
              states: [],
              hasMore: false,
              total: 0,
            }
          }

          const objectTypeIds = authz ? [...authz.grants["view:object"]] : undefined
          if (
            authz &&
            parsed.objectTypeId &&
            !isAllowed(authz, { kind: "object.view", objectTypeId: parsed.objectTypeId })
          ) {
            return {
              states: [],
              hasMore: false,
              total: 0,
            }
          }

          const result = await storage.listActive({
            projectId: sixb.id,
            ruleId: parsed.ruleId,
            objectTypeId: parsed.objectTypeId,
            objectTypeIds,
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
        response: { 200: RuleStateListResponseSchema, 400: ErrorResponseSchema },
        detail: {
          summary: "List active rule states",
          tags: [OPENAPI_TAGS.ruleStates.name],
          operationId: "listRuleStates",
        },
      }
    )
}
