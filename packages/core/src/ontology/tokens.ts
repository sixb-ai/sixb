import type { ObjectLink, ObjectType, Property } from "./types"

declare const propertyTokenBrand: unique symbol
declare const linkTokenBrand: unique symbol
declare const linkPathSelectionBrand: unique symbol

type LinkTargetObjectTypeId<TTarget> = TTarget extends readonly string[]
  ? TTarget[number]
  : TTarget extends "*"
    ? string
    : TTarget extends string
      ? TTarget
      : never

export type LinkPathSelectionMode =
  | { readonly kind: "none" }
  | { readonly kind: "all" }
  | {
      readonly kind: "selected"
      readonly links: readonly LinkPathSelection[]
    }

/**
 * Inert nested selection produced by `ObjectType.l.someLink.withLinks(...)`.
 *
 * It stores ids only. Consumers such as Share definitions resolve those ids against their own
 * current ontology registry instead of trusting the token's embedded metadata.
 */
export type LinkPathSelection<
  TSourceObjectTypeId extends string = string,
  TLinkId extends string = string,
  TTargetObjectTypeId extends string | readonly string[] = string | readonly string[],
> = {
  readonly [linkPathSelectionBrand]?: never
  readonly kind: "linkPathSelection"
  readonly sourceObjectTypeId: TSourceObjectTypeId
  readonly linkId: TLinkId
  readonly targetObjectTypeId: TTargetObjectTypeId
  readonly selection: LinkPathSelectionMode
}

export type LinkPathSelectionInput<TSourceObjectTypeId extends string = string> =
  | LinkToken<TSourceObjectTypeId>
  | LinkPathSelection<TSourceObjectTypeId>

export interface LinkPathSelectionBuilder<
  TSourceObjectTypeId extends string,
  TLinkId extends string,
  TTargetObjectTypeId extends string | readonly string[],
> {
  withLinks(): LinkPathSelection<TSourceObjectTypeId, TLinkId, TTargetObjectTypeId>
  withLinks<
    const TLinks extends readonly LinkPathSelectionInput<
      LinkTargetObjectTypeId<TTargetObjectTypeId>
    >[],
  >(links: TLinks): LinkPathSelection<TSourceObjectTypeId, TLinkId, TTargetObjectTypeId>
}

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

/** @internal Snapshot a token/path into the portable ids-only representation. */
export function snapshotLinkPathSelection(input: LinkPathSelectionInput): LinkPathSelection {
  return snapshotLinkPathSelectionValue(input, new Set())
}

function snapshotLinkPathSelectionValue(input: unknown, visiting: Set<object>): LinkPathSelection {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("[Sixb] Link path selection must be a link token or nested link selection.")
  }
  if (visiting.has(input)) {
    throw new Error("[Sixb] Link path selection must not contain a cycle.")
  }
  visiting.add(input)
  try {
    if (isLinkPathSelection(input)) {
      return createLinkPathSelectionFromIds(
        {
          sourceObjectTypeId: input.sourceObjectTypeId,
          linkId: input.linkId,
          targetObjectTypeId: input.targetObjectTypeId,
          selection: input.selection,
        },
        visiting
      )
    }

    return createLinkPathSelectionFromIds(
      {
        sourceObjectTypeId: (input as { readonly objectTypeId?: unknown }).objectTypeId,
        linkId: (input as { readonly id?: unknown }).id,
        targetObjectTypeId: (input as { readonly targetObjectTypeId?: unknown }).targetObjectTypeId,
        selection: { kind: "none" },
      },
      visiting
    )
  } finally {
    visiting.delete(input)
  }
}

/** @internal */
export function isLinkPathSelection(value: unknown): value is LinkPathSelection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "linkPathSelection"
  )
}

function createLinkPathSelection(
  token: LinkToken,
  links: readonly LinkPathSelectionInput[] | undefined
): LinkPathSelection {
  if (links !== undefined && !Array.isArray(links)) {
    throw new Error(`[Sixb] Link '${token.objectTypeId}.${token.id}' withLinks expects an array.`)
  }
  if (links?.length === 0) {
    throw new Error(
      `[Sixb] Link '${token.objectTypeId}.${token.id}' withLinks([]) is empty; omit withLinks() when no nested links should be selected.`
    )
  }

  return createLinkPathSelectionFromIds({
    sourceObjectTypeId: token.objectTypeId,
    linkId: token.id,
    targetObjectTypeId: token.targetObjectTypeId,
    selection:
      links === undefined
        ? { kind: "all" }
        : { kind: "selected", links: links.map(snapshotLinkPathSelection) },
  })
}

function createLinkPathSelectionFromIds(
  input: {
    readonly sourceObjectTypeId: unknown
    readonly linkId: unknown
    readonly targetObjectTypeId: unknown
    readonly selection: unknown
  },
  visiting: Set<object> = new Set()
): LinkPathSelection {
  const sourceObjectTypeId = nonEmptyLinkSelectionId(
    input.sourceObjectTypeId,
    "source object type id"
  )
  const linkId = nonEmptyLinkSelectionId(input.linkId, "link id")
  const targetObjectTypeId = snapshotLinkTarget(input.targetObjectTypeId)
  const selection = snapshotLinkSelectionMode(input.selection, visiting)
  return Object.freeze({
    kind: "linkPathSelection" as const,
    sourceObjectTypeId,
    linkId,
    targetObjectTypeId,
    selection,
  })
}

function snapshotLinkSelectionMode(value: unknown, visiting: Set<object>): LinkPathSelectionMode {
  if (typeof value !== "object" || value === null) {
    throw new Error("[Sixb] Link path selection must declare nested links.")
  }
  const kind = (value as { readonly kind?: unknown }).kind
  if (kind === "none" || kind === "all") return Object.freeze({ kind })
  if (kind !== "selected") {
    throw new Error(`[Sixb] Unknown nested link selection '${String(kind)}'.`)
  }
  const links = (value as { readonly links?: unknown }).links
  if (!Array.isArray(links)) {
    throw new Error("[Sixb] Selected nested links must be an array.")
  }
  if (links.length === 0) {
    throw new Error(
      "[Sixb] Selected nested links must not be empty; omit withLinks() when no nested links should be selected."
    )
  }
  return Object.freeze({
    kind: "selected" as const,
    links: Object.freeze(links.map((link) => snapshotLinkPathSelectionValue(link, visiting))),
  })
}

function snapshotLinkTarget(value: unknown): string | readonly string[] {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => nonEmptyLinkSelectionId(item, "target object type id"))
    )
  }
  return nonEmptyLinkSelectionId(value, "target object type id")
}

function nonEmptyLinkSelectionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[Sixb] Link path ${field} must not be empty.`)
  }
  return value
}
