import type { OntologyMigrationStep } from "../types"
import { convertProperty } from "./convert-property"
import { fillProperty } from "./fill-property"
import type { StepKind } from "./kind"
import { removeLink } from "./remove-link"
import { removeProperty } from "./remove-property"
import { renameProperty } from "./rename-property"

type StepKinds = {
  readonly [K in OntologyMigrationStep["kind"]]: StepKind<
    Extract<OntologyMigrationStep, { kind: K }>
  >
}

/** Every kind of step, in the order `sixb check` suggests them: rename before remove. */
export const stepKinds: StepKinds = {
  renameProperty,
  removeProperty,
  removeLink,
  fillProperty,
  convertProperty,
}

export function stepKindOf<S extends OntologyMigrationStep>(step: S): StepKind<S> {
  // The registry is keyed by kind, so the entry for `step.kind` is the kind of `step`: the
  // compiler can't follow that correlation through an indexed access.
  return stepKinds[step.kind] as unknown as StepKind<S>
}

/** The key two steps conflict on when both hold it: `convert:hours`. */
export function subjectKey(subject: { readonly role: string; readonly id: string }): string {
  return `${subject.role}:${subject.id}`
}
