import type { StoredObjectVector } from "../../ontology/vectors"
import type { ObjectLinkRow, ObjectRow } from "../types"

/** Project-bound read input shared by ordinary and selected in-memory queries. */
export interface InMemoryReadSource {
  readonly projectId: string
  getVector?(
    ref: { objectTypeId: string; primaryId: string },
    profile: string
  ): StoredObjectVector | undefined
  objectsOfType(objectTypeId: string): readonly ObjectRow[]
  getObject(objectTypeId: string, primaryId: string): ObjectRow | undefined
  outgoingLinks(objectTypeId: string, primaryId: string): Iterable<ObjectLinkRow>
  allLinks(): Iterable<ObjectLinkRow>
}
