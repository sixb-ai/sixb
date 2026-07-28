/**
 * Lowered, serializable definition interfaces for projection DSL.
 *
 * These are the runtime-inspectable data structures that projection builders
 * lower into. They use plain string ids (no tokens, no methods) so they can
 * be stored, serialized, and introspected by tooling.
 */

/**
 * Describes how a foreign key column in a dataset resolves to a link target.
 *
 * The source can be either a projected source property or a raw dataset field.
 * Its value equals the target object's primary property value, creating an
 * implicit link between source and target.
 *
 * `targetObjectTypeId` declares the concrete target type for this projection.
 * It must be the same type or a subtype (via `extends`) of the link's declared
 * target at the ontology level. Validation of the subtype relationship happens
 * at Sixb startup (Increment 7), not at DSL build time.
 */
export interface ForeignKeyDescriptor {
  readonly linkId: string
  /** Object property holding the target id. Mutually exclusive with sourceField. */
  readonly sourcePropertyId?: string
  /** Dataset column holding the target id. Mutually exclusive with sourcePropertyId. */
  readonly sourceField?: string
  readonly targetObjectTypeId: string
}

/**
 * Lowered, serializable definition for projecting a dataset into object instances.
 *
 * Each row contributes one complete object root to an authoritative replacement snapshot, with
 * properties mapped from dataset columns to object type properties. Duplicate roots are rejected.
 * FK links are resolved from source property or dataset field values to target object primary
 * values.
 */
export interface ObjectProjectionDefinition {
  readonly _tag: "ObjectProjectionDefinition"
  readonly id: string
  readonly objectTypeId: string
  readonly datasetId: string
  /** Maps object type property id -> dataset column name. */
  readonly properties: Readonly<Record<string, string>>
  /** Maps link id -> FK descriptor. Empty `{}` when no FK links are projected. */
  readonly links: Readonly<Record<string, ForeignKeyDescriptor>>
}

/**
 * Lowered, serializable definition for projecting a join dataset into link instances.
 *
 * Each row in the join dataset contributes one complete link root to an authoritative replacement
 * snapshot, identified by its source, link id, and target. Duplicate roots are rejected.
 */
export interface LinkProjectionDefinition {
  readonly _tag: "LinkProjectionDefinition"
  readonly id: string
  readonly linkId: string
  readonly sourceObjectTypeId: string
  readonly targetObjectTypeId: string
  readonly datasetId: string
  /** Dataset column holding the source object's primary property value. */
  readonly sourceField: string
  /** Dataset column holding the target object's primary property value. */
  readonly targetField: string
}

/**
 * Lowered, serializable definition for projecting dataset rows into telemetry history.
 *
 * Each row in the dataset becomes one telemetry point for a single object type property.
 * The target object type and property are fixed by the telemetry property token used by
 * the builder; the point mapping selects the dataset columns for object id, timestamp,
 * value, and optional unit.
 */
export interface TelemetryProjectionDefinition {
  readonly _tag: "TelemetryProjectionDefinition"
  readonly id: string
  readonly objectTypeId: string
  readonly propertyId: string
  readonly datasetId: string
  /** Dataset column holding the target object's primary id. */
  readonly objectIdField: string
  /** Dataset column holding the telemetry observation timestamp. */
  readonly atField: string
  /** Dataset column holding the telemetry value. */
  readonly valueField: string
  /** Dataset column holding the telemetry unit, when the property requires one. */
  readonly unitField?: string
}

/** Union of all projection definition types. */
export type ProjectionDefinition =
  | ObjectProjectionDefinition
  | LinkProjectionDefinition
  | TelemetryProjectionDefinition

export interface ProjectionOwnership {
  readonly objects: readonly {
    readonly objectTypeId: string
    readonly existence: boolean
    readonly propertyIds: readonly string[]
  }[]
  readonly links: readonly {
    readonly sourceObjectTypeId: string
    readonly linkId: string
  }[]
  readonly telemetry: readonly {
    readonly objectTypeId: string
    readonly propertyId: string
  }[]
}

/** Canonical correlation between a projection kind and its materialization protocol. */
export type ProjectionProtocolIdentity =
  | { readonly projectionKind: "object"; readonly protocol: "replacement" }
  | { readonly projectionKind: "link"; readonly protocol: "replacement" }
  | { readonly projectionKind: "telemetry"; readonly protocol: "telemetry" }

/**
 * Frozen semantic identity used to dispatch one registered projection.
 *
 * Dataset version metadata is attached only when a committed dataset event is routed. Keeping the
 * registry-owned fields together prevents the orchestrator from recomputing ontology semantics.
 */
export type ProjectionDispatchDescriptor = ProjectionDispatchDescriptorBase &
  ProjectionProtocolIdentity

interface ProjectionDispatchDescriptorBase {
  readonly projectionId: string
  readonly datasetId: string
  readonly ontologyRevision: string
  readonly projectionRevision: string
  readonly ownershipHash: string
}

export interface ResolvedProjection<TDefinition extends ProjectionDefinition> {
  readonly projectionId: string
  readonly datasetId: string
  readonly projectionRevision: string
  readonly ownershipHash: string
  readonly ownership: ProjectionOwnership
  readonly definition: TDefinition
}
