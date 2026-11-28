import type { OntologyMigrationStep } from "../types"
import { hasLink, quoted, type StepKind } from "./kind"

type RemoveLink = Extract<OntologyMigrationStep, { kind: "removeLink" }>

export const removeLink: StepKind<RemoveLink> = {
  phase: 2,

  describe: (step) => `removes link '${step.linkId}'`,

  refused: () => null,

  inert(step, type, typeName) {
    if (!hasLink(type, step.linkId)) return null
    return `removes link '${step.linkId}', which ${typeName} declares again`
  },

  appliesTo: (step, concrete) => !hasLink(concrete, step.linkId),

  subjects: (step) => [{ role: "link", id: step.linkId }],

  pending: (step, stored) => hasLink(stored, step.linkId),

  apply(step, stored) {
    const { [step.linkId]: _removed, ...links } = stored.links
    return { ...stored, links }
  },

  blocked: () => null,

  suggest(change) {
    if (change.kind !== "link-removed" || change.effect !== "narrowing") return null
    return { verb: "remove", call: `removeLink(${quoted(change.linkId)})` }
  },
}
