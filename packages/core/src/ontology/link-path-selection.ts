import type { LinkToken } from "./tokens"

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
function isLinkPathSelection(value: unknown): value is LinkPathSelection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly kind?: unknown }).kind === "linkPathSelection"
  )
}

export function createLinkPathSelection(
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
