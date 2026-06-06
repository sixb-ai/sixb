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
 * Each row in the dataset becomes an object upsert, with properties mapped
 * from dataset columns to object type properties. FK links are resolved from
 * source property or dataset field values to target object primary values.
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
 * Each row in the join dataset becomes a link between a source and target object,
 * identified by their respective primary property values.
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

/** Union of all projection definition types. */
export type ProjectionDefinition = ObjectProjectionDefinition | LinkProjectionDefinition
