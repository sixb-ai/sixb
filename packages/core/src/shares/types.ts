import type { ObjectTypeWithPropertyTokens } from "../ontology"
import type { ApplyGrant, ViewGrant } from "../security"

/** Grants a shared session may receive in V1. */
export type ShareTypeGrant = ViewGrant<"object"> | ApplyGrant

/** Declarative maximum authority for one kind of shared object page. */
export interface ShareTypeDefinition<
  TId extends string = string,
  TTarget extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
> {
  readonly kind: "share"
  readonly id: TId
  readonly target: TTarget
  readonly grants: readonly ShareTypeGrant[]
  readonly description?: string
}

export interface DefineShareTypeOptions<
  TId extends string,
  TTarget extends ObjectTypeWithPropertyTokens,
> {
  readonly id: TId
  readonly target: TTarget
  readonly grants: readonly ShareTypeGrant[]
  readonly description?: string
}
