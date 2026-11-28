import type { JsonValue } from "../json"
import type { ObjectTypeProperties, ObjectTypeWithPropertyTokens } from "../ontology/tokens"

/** The object as stored after the run's earlier steps: its effective values, as plain JSON. */
export type StoredObjectProperties = Readonly<Record<string, JsonValue>>

export interface FillPropertyInput {
  readonly primaryId: string
  readonly object: StoredObjectProperties
}

export interface ConvertPropertyInput {
  readonly primaryId: string
  /** The value an edit holds, in the old schema. */
  readonly value: JsonValue
  readonly object: StoredObjectProperties
}

/** One step of a migration, as plain data. */
export type OntologyMigrationStep =
  | { readonly kind: "removeProperty"; readonly propertyId: string }
  | { readonly kind: "removeLink"; readonly linkId: string }
  | { readonly kind: "renameProperty"; readonly from: string; readonly to: string }
  | {
      readonly kind: "fillProperty"
      readonly propertyId: string
      readonly fill: (input: FillPropertyInput) => unknown
    }
  | {
      readonly kind: "convertProperty"
      readonly propertyId: string
      readonly convert: (input: ConvertPropertyInput) => unknown
    }

/** What `defineMigration` declares: the steps that move one object type's stored objects. */
export interface MigrationDefinition<TId extends string = string, TTypeId extends string = string> {
  readonly kind: "migration"
  readonly id: TId
  readonly objectTypeId: TTypeId
  readonly steps: readonly OntologyMigrationStep[]
}

type PropertyIdOf<T extends ObjectTypeWithPropertyTokens> = Extract<keyof T["p"], string>

type ValueOf<
  T extends ObjectTypeWithPropertyTokens,
  P extends string,
> = P extends keyof ObjectTypeProperties<T> ? ObjectTypeProperties<T>[P] : never

/**
 * A migration of `T`, and the chain that adds its steps. Each call returns a new definition: the
 * value exported after the last call is the one discovered.
 */
export interface MigrationBuilder<TId extends string, T extends ObjectTypeWithPropertyTokens>
  extends MigrationDefinition<TId, T["id"]> {
  /** Deletes a property the type no longer declares: its values, edits and derived rows. */
  removeProperty(propertyId: string): MigrationBuilder<TId, T>

  /** Deletes a link the type no longer declares: its links and link edits. */
  removeLink(linkId: string): MigrationBuilder<TId, T>

  /** Moves a property the type no longer declares to one it does, with its edit times. */
  renameProperty(from: string, to: PropertyIdOf<T>): MigrationBuilder<TId, T>

  /** Gives a value to the objects created by actions that lack one. */
  fillProperty<const P extends PropertyIdOf<T>>(
    propertyId: P,
    fill: (input: FillPropertyInput) => ValueOf<T, P>
  ): MigrationBuilder<TId, T>

  /** Rewrites each edit's value of a property whose schema narrowed, keeping its edit time. */
  convertProperty<const P extends PropertyIdOf<T>>(
    propertyId: P,
    convert: (input: ConvertPropertyInput) => ValueOf<T, P>
  ): MigrationBuilder<TId, T>
}
