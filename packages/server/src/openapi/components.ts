import type { DocumentDecoration } from "elysia"
import type { ZodTypeAny, ZodTypeDef } from "zod"
import {
  ignoreOverride,
  type JsonSchema7Type,
  type OverrideCallback,
  zodToJsonSchema,
} from "zod-to-json-schema"
import {
  AgentChildAwaitingSchema,
  AgentChildEndedSchema,
  AgentChildFileSchema,
  AgentChildRunSchema,
  AgentChildSchema,
} from "../schemas/agents"
import { jsonValueOpenApiOverride } from "../schemas/common"

// The spec inlines every schema (`$refStrategy: "none"`), so a large shape several routes return
// repeats in each, and the generated client repeats its type. The schemas named here are emitted
// once under `components.schemas`, and a `$ref` wherever a route's schema holds one of them.

const NAMED: readonly (readonly [string, ZodTypeAny])[] = [
  ["AgentChild", AgentChildSchema],
  ["AgentChildRun", AgentChildRunSchema],
  ["AgentChildFile", AgentChildFileSchema],
  ["AgentChildAwaiting", AgentChildAwaitingSchema],
  ["AgentChildEnded", AgentChildEndedSchema],
]

const nameOf = new Map<ZodTypeDef, string>(NAMED.map(([name, schema]) => [schema._def, name]))

/** The server's override: JSON values as one open schema, and the named schemas by reference. */
export function openApiOverride(except?: ZodTypeDef): OverrideCallback {
  return (def, refs, seen, forceResolution) => {
    const json = jsonValueOpenApiOverride(def, refs, seen, forceResolution)
    if (json !== ignoreOverride) return json

    const name = def === except ? undefined : nameOf.get(def)
    return name === undefined
      ? ignoreOverride
      : ({ $ref: `#/components/schemas/${name}` } as JsonSchema7Type)
  }
}

/** A route's schema as the spec shows it. */
export function openApiJsonSchema(schema: ZodTypeAny) {
  return zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "openApi3",
    override: openApiOverride(),
  })
}

type RequestBody = Extract<NonNullable<DocumentDecoration["requestBody"]>, { content: unknown }>
type OpenApiSchema = RequestBody["content"][string]["schema"]

/** The documented JSON body of a route that reads its body itself, instead of through Elysia. */
export function jsonRequestBody(schema: ZodTypeAny): RequestBody {
  // The openApi3 target emits OpenAPI 3.0, which zod-to-json-schema still types as JSON Schema 7.
  const jsonSchema = openApiJsonSchema(schema) as OpenApiSchema
  return { required: true, content: { "application/json": { schema: jsonSchema } } }
}

/** The named schemas, each referencing the others it holds. */
export const NamedOpenApiSchemas = Object.fromEntries(
  NAMED.map(([name, schema]) => [
    name,
    zodToJsonSchema(schema, {
      $refStrategy: "none",
      target: "openApi3",
      override: openApiOverride(schema._def),
    }),
  ])
)
