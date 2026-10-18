import { expect, test } from "bun:test"
import type { ObjectSchema } from "@sixb/core"
import { runModelLoop } from "@sixb/core/internal/agents"
import { schemaFieldsToJsonSchema, validateSchemaOrRefValue } from "@sixb/core/internal/ontology"
import { vercelGateway } from "../src"

const modelId = process.env.SIXB_VERCEL_GATEWAY_E2E_MODEL
const hasCredential = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN
const liveTest = hasCredential && modelId ? test : test.skip

const classification: ObjectSchema = {
  type: "object",
  properties: {
    classification: {
      required: true,
      schema: {
        type: "object",
        properties: {
          kind: {
            required: true,
            schema: {
              type: "enum",
              valueType: "string",
              values: ["customer", "internal", "other"],
            },
          },
          confidence: { required: true, schema: "integer" },
          organization: {
            required: true,
            nullable: true,
            schema: {
              type: "object",
              properties: {
                name: { required: true, nullable: true, schema: "string" },
                domain: { required: true, nullable: true, schema: "string" },
              },
            },
          },
          rationale: { required: true, schema: "string" },
        },
      },
    },
  },
}

// Opt in with SIXB_VERCEL_GATEWAY_E2E_MODEL and a Gateway credential. Regression proof:
// the old metadata gate rejects GLM 5.3 Flash / Gemini 3.7 Flash before sending these schemas.
liveTest(
  "validates live strict nested classification output",
  async () => {
    const result = await runModelLoop({
      model: vercelGateway(modelId!, { maxOutputTokens: 2048 }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Classify this meeting as customer, internal, or other with integer confidence 0-100, organization details, and rationale: An internal team plans next week's work. There is no external organization.",
            },
          ],
        },
      ],
      output: {
        name: "classification",
        schema: schemaFieldsToJsonSchema({
          fields: classification.properties,
          valueTypesById: new Map(),
        }),
        validate(value) {
          validateSchemaOrRefValue(classification, value, "output", new Map())
          return value
        },
      },
      maxSteps: 1,
      signal: AbortSignal.timeout(60_000),
    })
    expect(result.status).toBe("completed")
  },
  70_000
)
