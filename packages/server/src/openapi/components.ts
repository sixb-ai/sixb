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
