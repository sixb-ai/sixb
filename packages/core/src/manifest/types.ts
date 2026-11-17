import type { DatasetDefinition } from "../datasets"
import type { DefinitionKind } from "./files"

/** What a runtime is made of, so two runtimes, such as production and a branch, can be compared. */
export interface DefinitionsManifest {
  /** The commit the runtime was deployed from, when a deploy set `SIXB_COMMIT`. */
  readonly commit: string | null
  /** Changes whenever any definition's hash does. */
  readonly hash: string
  readonly definitions: readonly ManifestDefinition[]
  /** What decides whether a projection rebuilds. */
  readonly projections: readonly ManifestProjection[]
  /** Each dataset as defined, to plan the schema change a deploy would make. */
  readonly datasets: readonly DatasetDefinition[]
}

export interface ManifestDefinition {
  readonly kind: DefinitionKind
  readonly id: string
  /** The project file that declares it. Absent for one passed to `createSixb` directly. */
  readonly file: string | null
  readonly hash: string
}

export interface ManifestProjection {
  readonly id: string
  readonly revision: string
}

export interface DefinitionChange {
  readonly kind: DefinitionKind
  readonly id: string
  readonly change: "added" | "changed" | "removed"
  /** Where it is declared: the newer runtime's file, or the older one's for a removal. */
  readonly file: string | null
}

/** What a deploy from one manifest to the other does to stored data. */
export interface ShipPlan {
  readonly projections: readonly ProjectionShipStep[]
  readonly datasets: readonly DatasetShipStep[]
}

export interface ProjectionShipStep {
  readonly id: string
  /** `build` for a new projection, `rebuild` when its definition, mapping or ownership changed. */
  readonly change: "build" | "rebuild" | "remove"
}

export type DatasetShipStep =
  | { readonly id: string; readonly change: "create" | "remove" }
  | { readonly id: string; readonly change: "addColumns"; readonly columns: readonly string[] }
  | { readonly id: string; readonly change: "metadata" }
  /** The deploy's lake check stops here: storage refuses the change. */
  | { readonly id: string; readonly change: "refused"; readonly reason: string }

export interface ManifestDiff {
  readonly changes: readonly DefinitionChange[]
  readonly plan: ShipPlan
}
