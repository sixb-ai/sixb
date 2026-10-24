import type { UniqueValueRef } from "../../ontology/materializations"
import type { StoredObjectVector } from "../../ontology/vectors"
import type { ObjectLinkRow, ObjectRow } from "../types"

/** Read input shared by ordinary and scoped in-memory queries; every method reads one project. */
export interface InMemoryReadSource {
  readonly projectId: string
  getVector?(
    ref: { objectTypeId: string; primaryId: string },
    profile: string
  ): StoredObjectVector | undefined
  allObjects(): Iterable<ObjectRow>
  objectsOfType(objectTypeId: string): readonly ObjectRow[]
  getObject(objectTypeId: string, primaryId: string): ObjectRow | undefined
  outgoingLinks(objectTypeId: string, primaryId: string): Iterable<ObjectLinkRow>
  allLinks(): Iterable<ObjectLinkRow>
  /** The primary id of the object holding a unique value. */
  uniqueHolder(value: UniqueValueRef): string | undefined
}

/** What a scoped reader sees of the store, resolved again for each of its operations. */
export interface InMemoryScopedReadSource extends InMemoryReadSource {
  /** Whether a property of a visible object may be read, whether or not it holds a value. */
  selectsProperty(objectTypeId: string, primaryId: string, propertyId: string): boolean
}
