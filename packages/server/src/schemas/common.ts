import { z } from "zod"
import { ignoreOverride, type JsonSchema7Type, type OverrideCallback } from "zod-to-json-schema"

export const ErrorResponseSchema = z.object({ error: z.string() })

export const SuccessResponseSchema = z.object({ success: z.boolean() })

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
)

/** A JSON null with an explicit runtime and generated-client type. */
export const JsonNullSchema = JsonValueSchema.refine((value): value is null => value === null)

const JsonValueOpenApiSchema = {
  description: "Any JSON-compatible value.",
  nullable: true,
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "array", items: {} },
    { type: "object", additionalProperties: true },
  ],
} as JsonSchema7Type

const jsonValueSchemaDef = JsonValueSchema._def
const jsonNullSchemaDef = JsonNullSchema._def

/**
 * Runtime validation needs the recursive JSON-value Zod schema above. OpenAPI
 * does not need to expand that recursion at every metadata/input leaf; these
 * fields are intentionally arbitrary JSON values. Emit that contract directly
 * so zod-to-json-schema does not hit its "$refStrategy: none" recursion path.
 */
export const jsonValueOpenApiOverride: OverrideCallback = (def) => {
  if (def === jsonValueSchemaDef) {
    return JsonValueOpenApiSchema
  }
  if (def === jsonNullSchemaDef) {
    return { nullable: true, enum: [null] } as JsonSchema7Type
  }

  return ignoreOverride
}
