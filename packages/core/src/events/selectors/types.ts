import type { ActionBinding, ActionDefinition, ActionParamsConfig } from "../../actions"
import type { LinkToken, ObjectTypeWithTokens } from "../../ontology"
import type { RuleDefinition } from "../../rules"
import type { PropertyChangeOperation } from "../property-changes"
import type { DomainEvent } from "../types"

declare const eventSelectorContextType: unique symbol

export type ObjectEventSelectorContext<
  TObjectType extends ObjectTypeWithTokens = ObjectTypeWithTokens,
> = {
  readonly kind: "object"
  readonly objectType: TObjectType
}

export type LinkEventSelectorContext<
  TObjectType extends ObjectTypeWithTokens = ObjectTypeWithTokens,
  TLink extends LinkToken<TObjectType["id"]> = LinkToken<TObjectType["id"]>,
> = {
  readonly kind: "link"
  readonly objectType: TObjectType
  readonly link: TLink
}

export type RuleEventSelectorOperation = "triggered" | "resolved"

export type RuleEventSelectorContext<
  TRule extends RuleDefinition = RuleDefinition,
  TOperation extends RuleEventSelectorOperation = RuleEventSelectorOperation,
> = {
  readonly kind: "rule"
  readonly rule: TRule
  readonly operation: TOperation
}

export type ActionEventSelectorOperation = "requested" | "completed" | "failed"

export type ActionEventToken<
  TId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
  TBinding extends ActionBinding = ActionBinding,
> = {
  readonly id: TId
  readonly params: TParams
  readonly binding: TBinding
}

export type ActionEventTokenOf<TAction extends ActionDefinition> = ActionEventToken<
  TAction["id"],
  TAction["params"],
  TAction["binding"]
>

export type ActionEventSelectorContext<
  TAction extends ActionEventToken = ActionEventToken,
  TOperation extends ActionEventSelectorOperation = ActionEventSelectorOperation,
> = {
  readonly kind: "action"
  readonly action: TAction
  readonly operation: TOperation
}

export type EventSelectorContext =
  | ObjectEventSelectorContext
  | LinkEventSelectorContext
  | RuleEventSelectorContext
  | ActionEventSelectorContext

export type InferEventSelectorContext<TSelector> = TSelector extends {
  readonly [eventSelectorContextType]?: infer TContext
}
  ? NonNullable<TContext>
  : EventSelectorContext

export interface EventSelectorSpec<TContext = EventSelectorContext> {
  readonly [eventSelectorContextType]?: TContext
  readonly topic?: DomainEvent["topic"]
  readonly types?: readonly DomainEvent["type"][]
  readonly objectTypeId?: string
  readonly primaryId?: string
  readonly propertyId?: string
  readonly propertyOperation?: PropertyChangeOperation
  readonly linkId?: string
  readonly ruleId?: string
  readonly actionId?: string
  readonly runId?: string
}
