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
 * The same recorded failure, for a request that could not be served rather than one that returns a
 * run: `code`, `details` and `cause` are the record's, and the message travels under `error`, the
 * key the API has always used.
 *
 * `error` keeps its name on purpose — renaming it to `message` would break every consumer for no
 * new capability. What was missing is the rest of the record: a `400 ontology.invalid_value` could
 * not say which field failed, though the failure knew, because this schema stopped at two fields.
 */
export const ErrorResponseSchema = SixbFailureSchema.omit({ message: true }).extend({
  error: z.string(),
})

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
const errorResponseSchemaDef = ErrorResponseSchema._def

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
  // Named for the same reason, and it matters more here: this shape is declared by nearly three
  // hundred responses. Inlined, widening it from two fields to four added ~6,700 lines to the
  // OpenAPI document and ~1,500 to the generated client; referenced, it is written once.
  // `error-response-component.test.ts` holds it to the Zod schema above.
  ErrorResponse: {
    description: "A request that could not be served, as the recorded failure.",
    type: "object" as const,
    properties: {
      error: { type: "string" as const, description: "The failure's message. Not a contract." },
      code: { $ref: "#/components/schemas/SixbErrorCode" },
      details: {
        type: "object" as const,
        description: "Flat scalar context: the field, the provider, the object type.",
        additionalProperties: {
          oneOf: [
            { type: "string" as const },
            { type: "number" as const },
            { type: "boolean" as const },
          ],
        },
      },
      cause: {
        type: "string" as const,
        description: "What the failure wrapped, outermost first.",
      },
    },
    required: ["error", "code"],
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
  if (def === errorResponseSchemaDef) {
    return { $ref: "#/components/schemas/ErrorResponse" } as JsonSchema7Type
  }

  return ignoreOverride
}
