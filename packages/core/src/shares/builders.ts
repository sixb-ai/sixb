import type { ObjectTypeWithPropertyTokens } from "../ontology"
import { assertGrantDefinition } from "../security/validation"
import { ShareError } from "./errors"
import { isRouteSafeShareTypeId, SHARE_TYPE_ID_REQUIREMENT } from "./id"
import type { DefineShareTypeOptions, ShareTypeDefinition, ShareTypeGrant } from "./types"

export function defineShareType<
  const TId extends string,
  const TTarget extends ObjectTypeWithPropertyTokens,
>(options: DefineShareTypeOptions<TId, TTarget>): ShareTypeDefinition<TId, TTarget> {
  if (!isRouteSafeShareTypeId(options.id)) {
    throw new ShareError("invalid_definition", `[Sixb] Share type id ${SHARE_TYPE_ID_REQUIREMENT}.`)
  }
  if (typeof options.target !== "object" || options.target === null || !options.target.id?.trim()) {
    throw new ShareError(
      "invalid_definition",
      `[Sixb] Share type '${options.id}' target must be an object type.`
    )
  }
  if (!Array.isArray(options.grants) || options.grants.length === 0) {
    throw new ShareError(
      "invalid_definition",
      `[Sixb] Share type '${options.id}' must declare at least one grant.`
    )
  }
  for (const grant of options.grants) {
    assertGrantDefinition(
      grant,
      `Share type '${options.id}' grants`,
      (message) => new ShareError("invalid_definition", message)
    )
  }
  if (options.description !== undefined && typeof options.description !== "string") {
    throw new ShareError(
      "invalid_definition",
      `[Sixb] Share type '${options.id}' description must be a string.`
    )
  }

  return Object.freeze({
    kind: "share" as const,
    id: options.id,
    target: options.target,
    grants: Object.freeze(options.grants.map(snapshotGrant)),
    ...(options.description === undefined ? {} : { description: options.description }),
  })
}

export function isShareTypeDefinition(value: unknown): value is ShareTypeDefinition {
  const candidate = value as Partial<ShareTypeDefinition> | null
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    candidate.kind === "share" &&
    typeof candidate.id === "string" &&
    typeof candidate.target === "object" &&
    candidate.target !== null &&
    typeof candidate.target.id === "string" &&
    Array.isArray(candidate.grants)
  )
}

function snapshotGrant(grant: ShareTypeGrant): ShareTypeGrant {
  const selection = grant.selection.all
    ? { all: true as const, except: Object.freeze([...grant.selection.except]) }
    : { all: false as const, ids: Object.freeze([...grant.selection.ids]) }
  return Object.freeze({ ...grant, selection })
}
