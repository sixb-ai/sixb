import type { LinkToken, ObjectTypeWithTokens } from "../../ontology"
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

export type EventSelectorContext = ObjectEventSelectorContext | LinkEventSelectorContext

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
  readonly actionId?: string
  readonly runId?: string
}
