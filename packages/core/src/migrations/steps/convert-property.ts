import { schemaWidens } from "../../ontology/type-shapes"
import type { OntologyMigrationStep } from "../types"
import {
  hasProperty,
  quoted,
  type StepKind,
  sameProperty,
  valueTargetRefused,
  withProperty,
} from "./kind"

type ConvertProperty = Extract<OntologyMigrationStep, { kind: "convertProperty" }>

export const convertProperty: StepKind<ConvertProperty> = {
  phase: 1,
  stagesValues: true,

  describe: (step) => `converts '${step.propertyId}'`,

  refused: (step, type, typeName) =>
    valueTargetRefused("converts", step.propertyId, type, typeName),

  inert: (step, type, typeName) =>
    hasProperty(type, step.propertyId)
      ? null
      : `converts '${step.propertyId}', which ${typeName} no longer declares`,

  appliesTo: (step, concrete, declaring) => sameProperty(concrete, declaring, step.propertyId),

  subjects: (step) => [{ role: "convert", id: step.propertyId }],

  // Only a narrowing: values a wider schema still accepts are never rewritten, so a convert kept
  // in the repo doesn't run again when the property later widens.
  pending(step, stored, code) {
    const from = stored.properties[step.propertyId]
    const to = code.properties[step.propertyId]
    if (!from || !to) return false

    return !schemaWidens(from.schema, to.schema) || (from.nullable === true && !to.nullable)
  },

  apply(step, stored, code) {
    const { nullable: _nullable, ...property } = stored.properties[step.propertyId]!
    const to = code.properties[step.propertyId]!

    return withProperty(stored, step.propertyId, {
      ...property,
      schema: to.schema,
      ...(to.nullable ? { nullable: true as const } : {}),
    })
  },

  blocked: () => null,

  suggest(change) {
    if (change.kind !== "property-retyped" && change.kind !== "property-not-nullable") return null
    if (change.effect !== "narrowing") return null

    return {
      verb: "convert",
      call: `convertProperty(${quoted(change.propertyId)}, ({ value }) => …)`,
    }
  },
}
