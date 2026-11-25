import type { OntologyMigrationStep } from "../types"
import { hasProperty, quoted, type StepKind, withoutProperty } from "./kind"

type RemoveProperty = Extract<OntologyMigrationStep, { kind: "removeProperty" }>

export const removeProperty: StepKind<RemoveProperty> = {
  phase: 2,

  describe: (step) => `removes '${step.propertyId}'`,

  refused: () => null,

  inert(step, type, typeName) {
    if (!hasProperty(type, step.propertyId)) return null
    return `removes '${step.propertyId}', which ${typeName} declares again`
  },

  appliesTo: (step, concrete) => !hasProperty(concrete, step.propertyId),

  subjects: (step) => [{ role: "property", id: step.propertyId }],

  // A series is never rewritten in V1: removing telemetry stays refused.
  pending: (step, stored) =>
    hasProperty(stored, step.propertyId) &&
    stored.properties[step.propertyId]!.mode !== "telemetry",

  apply: (step, stored) => withoutProperty(stored, step.propertyId),

  blocked: () => null,

  suggest(change) {
    if (change.kind !== "property-removed" || change.effect !== "narrowing") return null
    return { verb: "remove", call: `removeProperty(${quoted(change.propertyId)})` }
  },
}
