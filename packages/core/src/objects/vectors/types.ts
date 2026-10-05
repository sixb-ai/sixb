import type { ObjectType } from "../../ontology"

export type VectorProfileName<T extends ObjectType> = T extends { search: { vectors: infer P } }
  ? Extract<keyof P, string>
  : string extends T["id"]
    ? string
    : never

export interface ObjectVectorHandle {
  /** Generate and atomically store this profile using its configured model. Conflicts are not retried. */
  index(): Promise<void>
}
