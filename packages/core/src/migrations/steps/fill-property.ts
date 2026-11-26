import type { OntologyMigrationStep } from "../types"
import {
  hasProperty,
  quoted,
  type StepKind,
  sameProperty,
  valueTargetRefused,
  withProperty,
} from "./kind"

type FillProperty = Extract<OntologyMigrationStep, { kind: "fillProperty" }>

export const fillProperty: StepKind<FillProperty> = {
  phase: 1,
  stagesValues: true,

  describe: (step) => `fills '${step.propertyId}'`,

  refused: (step, type, typeName) => valueTargetRefused("fills", step.propertyId, type, typeName),

  inert: (step, type, typeName) =>
    hasProperty(type, step.propertyId)
      ? null
      : `fills '${step.propertyId}', which ${typeName} no longer declares`,

  appliesTo: (step, concrete, declaring) => sameProperty(concrete, declaring, step.propertyId),

  subjects: (step) => [{ role: "fill", id: step.propertyId }],

  pending: (step, stored, code) =>
    code.properties[step.propertyId]?.required === true &&
    stored.properties[step.propertyId]?.required !== true,

  apply(step, stored, code) {
    const property = stored.properties[step.propertyId]
    const filled = property
      ? { ...property, required: true as const }
      : code.properties[step.propertyId]!
    return withProperty(stored, step.propertyId, filled)
  },

  blocked: () => null,

  suggest(change) {
    if (change.kind !== "property-required" && change.kind !== "property-added") return null
    if (change.effect !== "narrowing") return null

    return { verb: "fill", call: `fillProperty(${quoted(change.propertyId)}, ({ object }) => …)` }
  },

  storeStep(step, context) {
    const unique = context.valueUnique.get(step.propertyId)
    return { kind: "fillProperty", propertyId: step.propertyId, ...(unique ? { unique } : {}) }
  },
}
