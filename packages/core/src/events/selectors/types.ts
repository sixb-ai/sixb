import type { PropertyChangeOperation } from "../property-changes"
import type { DomainEvent } from "../types"

export interface EventSelectorSpec {
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
