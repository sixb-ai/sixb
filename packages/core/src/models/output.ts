import { assertJsonObject } from "../json"
import { schemaRecordToJsonSchema } from "../ontology/json-schema"
import { isObjectRefSchema, validateSchemaOrRefValue } from "../ontology/refs"
import type { ValueType } from "../ontology/types"
import { isRecord } from "../ontology/validation"
import { coerceSchemaValueToTyped, normalizeSchemaValue } from "../ontology/validation/normalize"
import type { LanguageModelOutputShape } from "./generation-types"
import type { ModelOutput } from "./tools"

export function languageModelOutput(
  shape: LanguageModelOutputShape,
  valueTypesById: ReadonlyMap<string, ValueType>
): ModelOutput<Record<string, unknown>> {
  if (!isRecord(shape)) throw new TypeError("[SixbModels] output must be a Sixb schema record.")
  const schema = schemaRecordToJsonSchema({ shape, valueTypesById })
  assertJsonObject(schema, "model output schema")
  return {
    name: "sixb_output",
    schema,
    validate(value) {
      if (!isRecord(value)) throw new TypeError("[SixbModels] Output must be an object.")
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(shape, key)) {
          throw new TypeError(`[SixbModels] Unknown output field '${key}'.`)
        }
      }
      return Object.fromEntries(
        Object.entries(shape).map(([key, field]) => {
          if (!Object.hasOwn(value, key)) {
            throw new TypeError(`[SixbModels] Missing output field '${key}'.`)
          }
          validateSchemaOrRefValue(field, value[key], `output.${key}`, valueTypesById)
          const output = isObjectRefSchema(field)
            ? value[key]
            : coerceSchemaValueToTyped(
                field,
                normalizeSchemaValue(field, value[key], `output.${key}`, valueTypesById),
                valueTypesById
              )
          return [key, output]
        })
      )
    },
  }
}
