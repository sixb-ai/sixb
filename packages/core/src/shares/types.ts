import type { ObjectActionDefinition } from "../actions"
import type {
  LinkPathSelectionInput,
  LinkPathSelectionMode,
  ObjectTypeWithPropertyTokens,
} from "../ontology"

declare const shareTargetBrand: unique symbol

/** Contextual placeholder for the one exact object supplied when a Share is issued. */
export interface ShareTarget<TObjectTypeId extends string = string> {
  readonly [shareTargetBrand]: true
  readonly objectTypeId: TObjectTypeId
}

export interface ShareViewGrant<TObjectTypeId extends string = string> {
  readonly kind: "object.view"
  readonly targetObjectTypeId: TObjectTypeId
  readonly links: LinkPathSelectionMode
}

export interface ShareViewGrantBuilder<TObjectTypeId extends string = string>
  extends ShareViewGrant<TObjectTypeId> {
  /** Include every direct link present when a grant is issued. Nested links remain excluded. */
  withLinks(): ShareViewGrant<TObjectTypeId>
  /** Include only these link paths. Use a bare link token when it has no nested links. */
  withLinks<const TLinks extends readonly LinkPathSelectionInput<TObjectTypeId>[]>(
    links: TLinks
  ): ShareViewGrant<TObjectTypeId>
}

export interface ShareActionGrant<
  TActionId extends string = string,
  TObjectTypeId extends string = string,
> {
  readonly kind: "action.apply"
  readonly actionId: TActionId
  readonly subjectObjectTypeId: TObjectTypeId
}

export interface ShareActionGrantBuilder<
  TAction extends ObjectActionDefinition = ObjectActionDefinition,
> {
  on(
    target: ShareTarget<TAction["binding"]["objectType"]["id"]>
  ): ShareActionGrant<TAction["id"], TAction["binding"]["objectType"]["id"]>
}

export type ShareScopeGrant = ShareViewGrant | ShareActionGrant

export interface ShareDefinition<
  TId extends string = string,
  TTargetObjectTypeId extends string = string,
> {
  readonly kind: "share"
  /**
   * Durable authority identity. Removing a definition suspends its grants; reusing the id can make
   * unexpired grants effective again after intersection. Revoke them before permanent removal.
   */
  readonly id: TId
  readonly target: {
    readonly kind: "object"
    readonly objectTypeId: TTargetObjectTypeId
  }
  readonly grants: readonly ShareScopeGrant[]
  readonly description?: string
}

export interface DefineShareOptions<
  TTarget extends ObjectTypeWithPropertyTokens,
  TGrants extends readonly ShareScopeGrant[],
> {
  readonly target: TTarget
  readonly grants: (context: { readonly target: ShareTarget<TTarget["id"]> }) => TGrants
  readonly description?: string
}
