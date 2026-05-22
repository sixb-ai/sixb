import type { ObjectLink, ObjectType, Property } from "./types"

declare const propertyTokenBrand: unique symbol
declare const linkTokenBrand: unique symbol

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
}

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
 * The original ontology shape is preserved; this only adds typed handles.
 */
export type ObjectTypeWithPropertyTokens<TObjectType extends ObjectType = ObjectType> =
  TObjectType & {
    readonly p: PropertyTokenMap<TObjectType>
  }

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
    const token: LinkToken<
      TObjectType["id"],
      typeof link.id,
      typeof link.targetObjectTypeId,
      typeof link
    > = {
      objectTypeId: objectType.id,
      id: link.id,
      targetObjectTypeId: link.targetObjectTypeId,
      link,
    }
    return [link.id, token] as const
  })

  return Object.fromEntries(tokenEntries) as LinkTokenMap<TObjectType>
}
