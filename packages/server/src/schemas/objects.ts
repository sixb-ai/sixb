import type { ElysiaOpenAPIConfig } from "@elysiajs/openapi"
import { z } from "zod"

type OpenApiSchemas = NonNullable<
  NonNullable<ElysiaOpenAPIConfig["documentation"]>["components"]
>["schemas"]

export const ObjectParamsSchema = z.object({
  objectTypeId: z.string().min(1),
  objectId: z.string().min(1),
})

export const ObjectsQuerySchema = z.object({
  objectTypeId: z.string().optional(),
  idPrefix: z.string().optional(),
  idSuffix: z.string().optional(),
  updatedAfter: z.string().optional(),
  updatedBefore: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
  orderBy: z.enum(["createdAt", "updatedAt", "primaryId"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
})

export const UpsertObjectBodySchema = z.object({
  properties: z.record(z.unknown()),
})

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
)

export const ObjectQueryPredicateSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z
      .object({
        op: z.enum(["and", "or"]),
        items: z.array(ObjectQueryPredicateSchema),
      })
      .strict(),
    z
      .object({
        op: z.literal("not"),
        item: ObjectQueryPredicateSchema,
      })
      .strict(),
    z
      .object({
        op: z.enum(["eq", "neq", "lt", "lte", "gt", "gte"]),
        propertyId: z.string().min(1),
        value: JsonValueSchema,
      })
      .strict(),
    z
      .object({
        op: z.literal("in"),
        propertyId: z.string().min(1),
        values: z.array(JsonValueSchema),
      })
      .strict(),
    z
      .object({
        op: z.literal("exists"),
        propertyId: z.string().min(1),
        value: z.boolean(),
      })
      .strict(),
    z
      .object({
        op: z.literal("contains"),
        propertyId: z.string().min(1),
        value: JsonValueSchema,
      })
      .strict(),
  ])
)

export const ObjectQuerySortFieldSchema = z.union([
  z
    .object({
      kind: z.literal("property"),
      propertyId: z.string().min(1),
      direction: z.enum(["asc", "desc"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("relevance"),
      direction: z.enum(["asc", "desc"]).optional(),
    })
    .strict(),
])

export const ObjectQuerySchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("start"),
        objectTypeId: z.string().min(1),
        includeSubtypes: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("filter"),
        input: ObjectQuerySchema,
        predicate: ObjectQueryPredicateSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("text"),
        input: ObjectQuerySchema,
        query: z.string(),
        fields: z.array(z.string().min(1)).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("vector"),
        input: ObjectQuerySchema,
        vector: z.array(z.number().finite()),
        propertyId: z.string().min(1),
        k: z.number().int().positive(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("traverse"),
        input: ObjectQuerySchema,
        linkId: z.string().min(1),
        direction: z.enum(["outgoing", "incoming"]),
        sourceObjectTypeId: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("set"),
        op: z.enum(["union", "intersect", "subtract"]),
        inputs: z.array(ObjectQuerySchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("sort"),
        input: ObjectQuerySchema,
        fields: z.array(ObjectQuerySortFieldSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("limit"),
        input: ObjectQuerySchema,
        limit: z.number().int().nonnegative(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("page"),
        input: ObjectQuerySchema,
        pageSize: z.number().int().positive(),
        pageToken: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("project"),
        input: ObjectQuerySchema,
        properties: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  ])
)

export const ObjectQueryRequestSchema = z
  .object({
    query: ObjectQuerySchema,
    includeTotal: z.boolean().optional(),
  })
  .strict()

export const ObjectQueryCountRequestSchema = z
  .object({
    query: ObjectQuerySchema,
  })
  .strict()

export const ObjectQueryExistsRequestSchema = z
  .object({
    query: ObjectQuerySchema,
  })
  .strict()

export const ObjectQueryFacetRequestSchema = z
  .object({
    propertyId: z.string().min(1),
    limit: z.number().int().positive(),
  })
  .strict()

export const ObjectQueryFacetsRequestSchema = z
  .object({
    query: ObjectQuerySchema,
    facets: z.array(ObjectQueryFacetRequestSchema).min(1),
  })
  .strict()

export const TwinObjectSchema = z.object({
  primaryId: z.string(),
  objectTypeId: z.string(),
  properties: z.record(z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const ObjectListResponseSchema = z.object({
  objects: z.array(TwinObjectSchema),
  hasMore: z.boolean(),
  total: z.number(),
})

const anyJsonValueSchema = {}
const stringArraySchema = { type: "array", items: { type: "string", minLength: 1 } }
const objectQueryRef = { $ref: "#/components/schemas/ObjectQuery" }
const objectQueryPredicateRef = { $ref: "#/components/schemas/ObjectQueryPredicate" }
const objectQuerySortFieldRef = { $ref: "#/components/schemas/ObjectQuerySortField" }

/**
 * zod-to-json-schema currently drops recursive z.lazy schemas when the server's
 * OpenAPI config inlines refs. Keep the HTTP validator above in Zod, and provide
 * the recursive request contract directly for generated clients and docs.
 */
export const ObjectQueryOpenApiSchemas = {
  ErrorResponse: {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    properties: {
      error: { type: "string" },
    },
  },
  ObjectQueryObject: {
    type: "object",
    required: ["primaryId", "objectTypeId", "properties", "createdAt", "updatedAt"],
    additionalProperties: false,
    properties: {
      primaryId: { type: "string" },
      objectTypeId: { type: "string" },
      properties: { type: "object", additionalProperties: true },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
  },
  ObjectQueryIssue: {
    type: "object",
    required: ["path", "code", "message"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      code: { type: "string" },
      message: { type: "string" },
    },
  },
  ObjectQueryPlanSummary: {
    type: "object",
    required: ["mode", "providerIssues", "fallbackIssues", "issues"],
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["pushdown", "fallback", "rejected"] },
      providerIssues: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryIssue" },
      },
      fallbackIssues: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryIssue" },
      },
      issues: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryIssue" },
      },
      fallback: {
        type: "object",
        required: ["maxRows", "requiresExplicitBound"],
        additionalProperties: false,
        properties: {
          maxRows: { type: "number" },
          requiresExplicitBound: { type: "boolean" },
        },
      },
    },
  },
  ObjectQueryResponse: {
    type: "object",
    required: ["objects", "hasMore", "plan"],
    additionalProperties: false,
    properties: {
      objects: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryObject" },
      },
      hasMore: { type: "boolean" },
      total: { type: "number" },
      nextPageToken: { type: "string" },
      plan: { $ref: "#/components/schemas/ObjectQueryPlanSummary" },
    },
  },
  ObjectQueryCountResponse: {
    type: "object",
    required: ["count", "plan"],
    additionalProperties: false,
    properties: {
      count: { type: "number" },
      plan: { $ref: "#/components/schemas/ObjectQueryPlanSummary" },
    },
  },
  ObjectQueryExistsResponse: {
    type: "object",
    required: ["exists", "plan"],
    additionalProperties: false,
    properties: {
      exists: { type: "boolean" },
      plan: { $ref: "#/components/schemas/ObjectQueryPlanSummary" },
    },
  },
  ObjectQueryFacetBucket: {
    type: "object",
    required: ["value", "count"],
    additionalProperties: false,
    properties: {
      value: anyJsonValueSchema,
      count: { type: "number" },
    },
  },
  ObjectQueryFacetResult: {
    type: "object",
    required: ["propertyId", "buckets"],
    additionalProperties: false,
    properties: {
      propertyId: { type: "string" },
      buckets: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryFacetBucket" },
      },
    },
  },
  ObjectQueryFacetsResponse: {
    type: "object",
    required: ["facets", "plan"],
    additionalProperties: false,
    properties: {
      facets: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryFacetResult" },
      },
      plan: { $ref: "#/components/schemas/ObjectQueryPlanSummary" },
    },
  },
  ObjectQueryErrorResponse: {
    type: "object",
    required: ["error"],
    additionalProperties: false,
    properties: {
      error: { type: "string" },
      issues: {
        type: "array",
        items: { $ref: "#/components/schemas/ObjectQueryIssue" },
      },
    },
  },
  ObjectQueryRequest: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: objectQueryRef,
      includeTotal: { type: "boolean" },
    },
  },
  ObjectQueryCountRequest: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: objectQueryRef,
    },
  },
  ObjectQueryExistsRequest: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: objectQueryRef,
    },
  },
  ObjectQueryFacetRequest: {
    type: "object",
    required: ["propertyId", "limit"],
    additionalProperties: false,
    properties: {
      propertyId: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1 },
    },
  },
  ObjectQueryFacetsRequest: {
    type: "object",
    required: ["query", "facets"],
    additionalProperties: false,
    properties: {
      query: objectQueryRef,
      facets: {
        type: "array",
        minItems: 1,
        items: { $ref: "#/components/schemas/ObjectQueryFacetRequest" },
      },
    },
  },
  ObjectQuery: {
    oneOf: [
      {
        type: "object",
        required: ["kind", "objectTypeId"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["start"] },
          objectTypeId: { type: "string", minLength: 1 },
          includeSubtypes: { type: "boolean" },
        },
      },
      {
        type: "object",
        required: ["kind", "input", "predicate"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["filter"] },
          input: objectQueryRef,
          predicate: objectQueryPredicateRef,
        },
      },
      {
        type: "object",
        required: ["kind", "input", "query"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["text"] },
          input: objectQueryRef,
          query: { type: "string" },
          fields: stringArraySchema,
        },
      },
      {
        type: "object",
        required: ["kind", "input", "vector", "propertyId", "k"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["vector"] },
          input: objectQueryRef,
          vector: { type: "array", items: { type: "number" } },
          propertyId: { type: "string", minLength: 1 },
          k: { type: "integer", minimum: 1 },
        },
      },
      {
        type: "object",
        required: ["kind", "input", "linkId", "direction"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["traverse"] },
          input: objectQueryRef,
          linkId: { type: "string", minLength: 1 },
          direction: { type: "string", enum: ["outgoing", "incoming"] },
          sourceObjectTypeId: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object",
        required: ["kind", "op", "inputs"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["set"] },
          op: { type: "string", enum: ["union", "intersect", "subtract"] },
          inputs: { type: "array", items: objectQueryRef },
        },
      },
      {
        type: "object",
        required: ["kind", "input", "fields"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["sort"] },
          input: objectQueryRef,
          fields: { type: "array", items: objectQuerySortFieldRef },
        },
      },
      {
        type: "object",
        required: ["kind", "input", "limit"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["limit"] },
          input: objectQueryRef,
          limit: { type: "integer", minimum: 0 },
        },
      },
      {
        type: "object",
        required: ["kind", "input", "pageSize"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["page"] },
          input: objectQueryRef,
          pageSize: { type: "integer", minimum: 1 },
          pageToken: { type: "string" },
        },
      },
      {
        type: "object",
        required: ["kind", "input"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["project"] },
          input: objectQueryRef,
          properties: stringArraySchema,
        },
      },
    ],
    discriminator: { propertyName: "kind" },
  },
  ObjectQueryPredicate: {
    oneOf: [
      {
        type: "object",
        required: ["op", "items"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["and", "or"] },
          items: { type: "array", items: objectQueryPredicateRef },
        },
      },
      {
        type: "object",
        required: ["op", "item"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["not"] },
          item: objectQueryPredicateRef,
        },
      },
      {
        type: "object",
        required: ["op", "propertyId", "value"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["eq", "neq", "lt", "lte", "gt", "gte"] },
          propertyId: { type: "string", minLength: 1 },
          value: anyJsonValueSchema,
        },
      },
      {
        type: "object",
        required: ["op", "propertyId", "values"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["in"] },
          propertyId: { type: "string", minLength: 1 },
          values: { type: "array", items: anyJsonValueSchema },
        },
      },
      {
        type: "object",
        required: ["op", "propertyId", "value"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["exists"] },
          propertyId: { type: "string", minLength: 1 },
          value: { type: "boolean" },
        },
      },
      {
        type: "object",
        required: ["op", "propertyId", "value"],
        additionalProperties: false,
        properties: {
          op: { type: "string", enum: ["contains"] },
          propertyId: { type: "string", minLength: 1 },
          value: anyJsonValueSchema,
        },
      },
    ],
    discriminator: { propertyName: "op" },
  },
  ObjectQuerySortField: {
    oneOf: [
      {
        type: "object",
        required: ["kind", "propertyId"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["property"] },
          propertyId: { type: "string", minLength: 1 },
          direction: { type: "string", enum: ["asc", "desc"] },
        },
      },
      {
        type: "object",
        required: ["kind"],
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["relevance"] },
          direction: { type: "string", enum: ["asc", "desc"] },
        },
      },
    ],
    discriminator: { propertyName: "kind" },
  },
} as unknown as OpenApiSchemas
