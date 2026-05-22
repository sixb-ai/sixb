import type { RulePredicate } from "@pario/core"
import { z } from "zod"

export const RuleParamsSchema = z.object({
  ruleId: z.string().min(1),
})

export const RuleStatesQuerySchema = z.object({
  ruleId: z.string().optional(),
  objectTypeId: z.string().optional(),
  primaryId: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

const RuleValueSchema = z.union([z.string(), z.number(), z.boolean()]).nullable()

const RuleSubjectSchema = z.object({
  kind: z.literal("object"),
  objectTypeId: z.string(),
})

const RuleEventSubjectSchema = z.object({
  kind: z.literal("object"),
  objectTypeId: z.string(),
  primaryId: z.string(),
})

const RulePropertyPredicateSchema = z.object({
  kind: z.literal("property"),
  propertyId: z.string(),
  op: z.enum(["eq", "notEq", "gt", "gte", "lt", "lte", "isPresent", "isMissing"]),
  value: RuleValueSchema.optional(),
})

const RuleLinkPredicateSchema = z.object({
  kind: z.literal("link"),
  linkId: z.string(),
  op: z.enum(["exists", "isMissing"]),
})

function createRulePredicateSchema(childPredicateSchema: z.ZodType<unknown>) {
  return z.union([
    z.object({
      kind: z.literal("all"),
      predicates: z.array(childPredicateSchema),
    }),
    z.object({
      kind: z.literal("any"),
      predicates: z.array(childPredicateSchema),
    }),
    z.object({
      kind: z.literal("not"),
      predicate: childPredicateSchema,
    }),
    RulePropertyPredicateSchema,
    RuleLinkPredicateSchema,
  ])
}

const DeepRulePredicateSchema = createRulePredicateSchema(z.unknown())
const NestedRulePredicateSchema = createRulePredicateSchema(DeepRulePredicateSchema)

export const RulePredicateSchema = NestedRulePredicateSchema as z.ZodType<RulePredicate>

const RuleEventDependencySchema = z.union([
  z.object({
    type: z.literal("object.upserted"),
    objectTypeId: z.string(),
  }),
  z.object({
    type: z.literal("link.upserted"),
    sourceTypeId: z.string(),
    linkId: z.string(),
  }),
  z.object({
    type: z.literal("link.removed"),
    sourceTypeId: z.string(),
    linkId: z.string(),
  }),
])

export const RuleSchema = z.object({
  kind: z.literal("rule"),
  id: z.string(),
  subject: RuleSubjectSchema,
  predicate: RulePredicateSchema,
  dependencies: z.array(RuleEventDependencySchema),
})

export const RuleStateSchema = z.object({
  projectId: z.string(),
  ruleId: z.string(),
  subject: RuleEventSubjectSchema,
  triggeredAt: z.string(),
})

export const RuleStateListResponseSchema = z.object({
  states: z.array(RuleStateSchema),
  hasMore: z.boolean(),
  total: z.number(),
})
