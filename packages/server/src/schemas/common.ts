import { SIXB_ERROR_CODES } from "@sixb/core/errors"
import { z } from "zod"
import { ignoreOverride, type JsonSchema7Type, type OverrideCallback } from "zod-to-json-schema"

/**
 * Closed, so the OpenAPI document declares an enum and the generated client autocompletes it.
 * Adding a code is a minor version bump; see `docs/runtime/error-codes.md`.
 */
export const SixbErrorCodeSchema = z.enum(SIXB_ERROR_CODES)

/**
 * The recorded failure, unchanged from the run row it was read out of.
 *
 * Every primitive's run answers with this shape, so a client that learned to read a failed sync
 * reads a failed workflow with the same code. A primitive that owns one extra typed field extends
 * it — an action run adds the `phase` it died in — and never re-specifies a field already here.
 */
export const SixbFailureSchema = z.object({
  code: SixbErrorCodeSchema,
  message: z.string(),
  details: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  cause: z.string().optional(),
})

/**
 * `error` is for the person reading it and may be reworded in a patch release; `code` is the
 * contract. Required, so a caller never has to fall back to matching on the message.
 */
export const ErrorResponseSchema = z.object({ error: z.string(), code: SixbErrorCodeSchema })

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
const sixbErrorCodeSchemaDef = SixbErrorCodeSchema._def

/**
 * Shared components the document refers to by name.
 *
 * The code enum has to be one of them. Emitting it inline would repeat all of it at every error
 * response the API declares — a few hundred of them — and the generated client would carry the same
 * union that many times over. As a component it is written once and referenced.
 */
export const SharedOpenApiSchemas = {
  SixbErrorCode: {
    description: "The stable machine code every Sixb failure carries.",
    type: "string" as const,
    enum: [...SIXB_ERROR_CODES] as string[],
  },
}

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
  if (def === sixbErrorCodeSchemaDef) {
    return { $ref: "#/components/schemas/SixbErrorCode" } as JsonSchema7Type
  }

  return ignoreOverride
}
