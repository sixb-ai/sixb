import type { InferObjectProperties } from "./inference"
import {
  createLinkPathSelection,
  type LinkPathSelectionBuilder,
  type LinkPathSelectionInput,
} from "./link-path-selection"
import type { ObjectLink, ObjectType, Property } from "./types"

declare const propertyTokenBrand: unique symbol
declare const linkTokenBrand: unique symbol
declare const objectPropertiesBrand: unique symbol

/**
 * Strongly-typed handle to a property on a specific object type.
 *
 * Tokens let runtime APIs accept object properties without using string ids.
 */
export type PropertyToken<
  TObjectTypeId extends string = string,
  TPropertyId extends string = string,
  TProperty extends Property = Property,
> = {
  readonly [propertyTokenBrand]?: never
  readonly objectTypeId: TObjectTypeId
  readonly id: TPropertyId
  readonly property: TProperty
}

export type PropertyTokenMap<TObjectType extends ObjectType> = {
  readonly [P in TObjectType["properties"][number] as P["id"]]: PropertyToken<
    TObjectType["id"],
    P["id"],
    P
  >
}

export type LinkToken<
  TObjectTypeId extends string = string,
  TLinkId extends string = string,
  TTargetObjectTypeId extends string | readonly string[] = string | readonly string[],
  TLink extends ObjectLink = ObjectLink,
> = {
  readonly [linkTokenBrand]?: never
  readonly objectTypeId: TObjectTypeId
  readonly id: TLinkId
  readonly targetObjectTypeId: TTargetObjectTypeId
  readonly link: TLink
} & LinkPathSelectionBuilder<TObjectTypeId, TLinkId, TTargetObjectTypeId>

export type LinkTokenMap<TObjectType extends ObjectType> = {
  readonly [L in TObjectType["links"][number] as L["id"]]: LinkToken<
    TObjectType["id"],
    L["id"],
    L["targetObjectTypeId"],
    L
  >
}

/**
 * Object type with property tokens (`p.*`).
 *
 * The original ontology shape is preserved; this only adds typed handles, and the type-only
 * property values every row of this object type carries.
 */
export type ObjectTypeWithPropertyTokens<TObjectType extends ObjectType = ObjectType> =
  TObjectType & {
    readonly p: PropertyTokenMap<TObjectType>
  } & ObjectPropertiesMetadata<TObjectType>

/**
 * Type-only property values of an object type, inferred once where the type is defined so SDK types
 * read them back by indexed access instead of re-deriving them from `properties`.
 *
 * Exported only so declaration files can name it, like the token maps.
 */
export type ObjectPropertiesMetadata<TObjectType extends ObjectType> = {
  readonly [objectPropertiesBrand]?: string extends TObjectType["id"]
    ? { readonly properties: Record<string, unknown> }
    : ObjectPropertiesCarrier<TObjectType>
}

/**
 * Carrier of an object type's inferred property values.
 *
 * When TypeScript relates, or infers between, two instantiations of a generic type it has not been
 * told the variance of, it measures that variance by probing the type with marker types. A probe
 * that reached the schema inference over a marker overflowed its depth limits (TS2589), in code as
 * ordinary as reassigning a query. Declaring this carrier invariant stops every probe here, so an
 * object type costs no more to relate than its tokens. The loose base type carries a plain record
 * instead, which a concrete object type's carrier relates to structurally.
 */
interface ObjectPropertiesCarrier<in out TObjectType extends ObjectType> {
  readonly properties: InferObjectProperties<TObjectType>
}

/**
 * The property values of an object type, as its rows carry them.
 *
 * Reads the type computed once by {@link ObjectTypeWithPropertyTokens}. For the loose base type,
 * whose property ids are not statically known, it is `Record<string, unknown>`.
 */
export type ObjectTypeProperties<TObjectType extends ObjectTypeWithPropertyTokens> = NonNullable<
  TObjectType[typeof objectPropertiesBrand]
>["properties"]

/**
 * Object type with property tokens (`p.*`) and link tokens (`l.*`).
 *
 * `links` is a plain array for iteration.
 * `l` provides keyed token access (`Room.l.hasThermostat`).
 */
export type ObjectTypeWithTokens<TObjectType extends ObjectType = ObjectType> =
  ObjectTypeWithPropertyTokens<TObjectType> & {
    readonly l: LinkTokenMap<TObjectType>
  }

/**
 * Build the `objectType.p.*` token map once when the object type is defined.
 */
export function createPropertyTokenMap<TObjectType extends ObjectType>(
  objectType: TObjectType
): PropertyTokenMap<TObjectType> {
  const tokenEntries = objectType.properties.map((property) => {
    const token: PropertyToken<TObjectType["id"], typeof property.id, typeof property> = {
      objectTypeId: objectType.id,
      id: property.id,
      property,
    }
    return [property.id, token] as const
  })

  return Object.fromEntries(tokenEntries) as PropertyTokenMap<TObjectType>
}

/**
 * Build the `objectType.l.*` link token map once when the object type is defined.
 */
export function createLinkTokenMap<TObjectType extends ObjectType>(
  objectType: TObjectType
): LinkTokenMap<TObjectType> {
  const tokenEntries = objectType.links.map((link) => {
    const token = {
      objectTypeId: objectType.id,
      id: link.id,
      targetObjectTypeId: link.targetObjectTypeId,
      link,
    } as LinkToken<TObjectType["id"], typeof link.id, typeof link.targetObjectTypeId, typeof link>
    Object.defineProperty(token, "withLinks", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (...args: [links?: readonly LinkPathSelectionInput[]]) =>
        createLinkPathSelection(token, args.length === 0 ? undefined : args[0]),
    })
    return [link.id, token] as const
  })

  return Object.fromEntries(tokenEntries) as LinkTokenMap<TObjectType>
}
