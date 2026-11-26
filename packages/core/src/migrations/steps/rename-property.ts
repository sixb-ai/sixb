import type { OntologyMigrationStep } from "../types"
import {
  hasProperty,
  quoted,
  type StepKind,
  sameProperty,
  valueTargetRefused,
  withoutProperty,
  withProperty,
} from "./kind"

type RenameProperty = Extract<OntologyMigrationStep, { kind: "renameProperty" }>

export const renameProperty: StepKind<RenameProperty> = {
  phase: 0,

  describe: (step) => `renames '${step.from}' to '${step.to}'`,

  refused(step, type, typeName) {
    if (step.from === step.to) return `renames '${step.from}' to itself.`
    return valueTargetRefused(`renames '${step.from}' to`, step.to, type, typeName)
  },

  inert(step, type, typeName) {
    if (hasProperty(type, step.from)) {
      return `renames '${step.from}', which ${typeName} declares again`
    }
    if (!hasProperty(type, step.to)) {
      return `renames '${step.from}' to '${step.to}', which ${typeName} no longer declares`
    }
    return null
  },

  appliesTo: (step, concrete, declaring) =>
    !hasProperty(concrete, step.from) && sameProperty(concrete, declaring, step.to),

  subjects: (step) => [
    { role: "property", id: step.from },
    { role: "renamedTo", id: step.to },
  ],

  pending(step, stored) {
    const from = stored.properties[step.from]
    return from !== undefined && from.mode !== "telemetry" && !hasProperty(stored, step.to)
  },

  apply(step, stored) {
    const { unknown: _unknown, ...moved } = stored.properties[step.from]!
    return withProperty(withoutProperty(stored, step.from), step.to, moved)
  },

  blocked(step, stored, typeName) {
    if (!hasProperty(stored, step.from) || !hasProperty(stored, step.to)) return null
    return `the stored ${typeName} already has '${step.to}'.`
  },

  storedKey: (step, propertyId) => (propertyId === step.to ? step.from : undefined),

  suggest(change) {
    if (change.kind !== "property-removed" || change.effect !== "narrowing") return null
    return { verb: "rename", call: `renameProperty(${quoted(change.propertyId)}, "<new id>")` }
  },

  storeStep: (step, context) => ({
    kind: "renameProperty",
    from: step.from,
    to: step.to,
    unique: context.uniqueMoves.has(step.from) ? "move" : "drop",
  }),
}
