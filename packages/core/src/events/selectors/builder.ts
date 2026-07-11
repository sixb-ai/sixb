import type { LinkToken, ObjectTypeWithTokens, Property, PropertyToken } from "../../ontology"
import type { DomainEvent } from "../types"
import type { EventSelectorSpec } from "./types"

type EventPropertySelectorMap<TTokens> = {
  readonly [K in keyof TTokens]: TTokens[K] extends PropertyToken ? EventPropertySelector : never
}

type LinkPropertyTokens<TLink extends LinkToken> =
  NonNullable<TLink["link"]["properties"]> extends readonly Property[]
    ? {
        readonly [P in NonNullable<TLink["link"]["properties"]>[number] as P["id"]]: PropertyToken<
          TLink["objectTypeId"],
          P["id"],
          P
        >
      }
    : Record<never, never>

export interface ObjectEventSelectorBuilder<TObjectType extends ObjectTypeWithTokens>
  extends EventSelectorSpec {
  readonly p: EventPropertySelectorMap<TObjectType["p"]>

  created(): EventSelectorSpec
  updated(): EventSelectorSpec
  deleted(): EventSelectorSpec

  link<TLink extends LinkToken<TObjectType["id"]>>(
    link: TLink
  ): LinkEventSelectorBuilder<TObjectType, TLink>
}

export interface LinkEventSelectorBuilder<
  TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken<TObjectType["id"]>,
> extends EventSelectorSpec {
  readonly p: EventPropertySelectorMap<LinkPropertyTokens<TLink>>

  created(): EventSelectorSpec
  updated(): EventSelectorSpec
  deleted(): EventSelectorSpec
  /** @deprecated Use `.deleted()` instead. */
  removed(): EventSelectorSpec
}

export interface EventPropertySelector extends EventSelectorSpec {
  created(): EventSelectorSpec
  updated(): EventSelectorSpec
  cleared(): EventSelectorSpec
}

abstract class EventSelectorSpecView implements EventSelectorSpec {
  constructor(protected readonly spec: EventSelectorSpec) {}

  get topic(): EventSelectorSpec["topic"] {
    return this.spec.topic
  }

  get types(): EventSelectorSpec["types"] {
    return this.spec.types
  }

  get objectTypeId(): EventSelectorSpec["objectTypeId"] {
    return this.spec.objectTypeId
  }

  get primaryId(): EventSelectorSpec["primaryId"] {
    return this.spec.primaryId
  }

  get propertyId(): EventSelectorSpec["propertyId"] {
    return this.spec.propertyId
  }

  get propertyOperation(): EventSelectorSpec["propertyOperation"] {
    return this.spec.propertyOperation
  }

  get linkId(): EventSelectorSpec["linkId"] {
    return this.spec.linkId
  }

  get actionId(): EventSelectorSpec["actionId"] {
    return this.spec.actionId
  }

  get runId(): EventSelectorSpec["runId"] {
    return this.spec.runId
  }
}

class ObjectEventSelectorBuilderImpl<TObjectType extends ObjectTypeWithTokens>
  extends EventSelectorSpecView
  implements ObjectEventSelectorBuilder<TObjectType>
{
  constructor(
    private readonly objectType: TObjectType,
    spec: EventSelectorSpec
  ) {
    super(spec)
  }

  get p(): EventPropertySelectorMap<TObjectType["p"]> {
    return createPropertySelectorMap(
      this.objectType.p,
      (property) =>
        new EventPropertySelectorImpl({
          ...this.spec,
          topic: "objects",
          propertyId: property.id,
        })
    ) as EventPropertySelectorMap<TObjectType["p"]>
  }

  created(): EventSelectorSpec {
    return this.withObjectEventType("object.created")
  }

  updated(): EventSelectorSpec {
    return this.withObjectEventType("object.updated")
  }

  deleted(): EventSelectorSpec {
    return this.withObjectEventType("object.deleted")
  }

  link<TLink extends LinkToken<TObjectType["id"]>>(
    link: TLink
  ): LinkEventSelectorBuilder<TObjectType, TLink> {
    return new LinkEventSelectorBuilderImpl(link, {
      ...this.spec,
      topic: "links",
      linkId: link.id,
    })
  }

  private withObjectEventType(type: "object.created" | "object.updated" | "object.deleted") {
    const spec: EventSelectorSpec = {
      ...this.spec,
      topic: "objects",
      types: [type],
    }
    return spec
  }
}

class LinkEventSelectorBuilderImpl<
    TObjectType extends ObjectTypeWithTokens,
    TLink extends LinkToken<TObjectType["id"]>,
  >
  extends EventSelectorSpecView
  implements LinkEventSelectorBuilder<TObjectType, TLink>
{
  constructor(
    private readonly linkToken: TLink,
    spec: EventSelectorSpec
  ) {
    super(spec)
  }

  get p(): EventPropertySelectorMap<LinkPropertyTokens<TLink>> {
    return createPropertySelectorMap(
      createLinkPropertyTokens(this.linkToken),
      (property) =>
        new EventPropertySelectorImpl({
          ...this.spec,
          topic: "links",
          propertyId: property.id,
        })
    ) as EventPropertySelectorMap<LinkPropertyTokens<TLink>>
  }

  created(): EventSelectorSpec {
    return this.withLinkEventType("link.created")
  }

  updated(): EventSelectorSpec {
    return this.withLinkEventType("link.updated")
  }

  deleted(): EventSelectorSpec {
    return this.withLinkEventType("link.deleted")
  }

  removed(): EventSelectorSpec {
    return this.deleted()
  }

  private withLinkEventType(type: "link.created" | "link.updated" | "link.deleted") {
    const spec: EventSelectorSpec = {
      ...this.spec,
      topic: "links",
      types: [type],
    }
    return spec
  }
}

class EventPropertySelectorImpl extends EventSelectorSpecView implements EventPropertySelector {
  created(): EventSelectorSpec {
    return this.withPropertyOperation("created")
  }

  updated(): EventSelectorSpec {
    return this.withPropertyOperation("updated")
  }

  cleared(): EventSelectorSpec {
    return this.withPropertyOperation("cleared")
  }

  private withPropertyOperation(propertyOperation: EventSelectorSpec["propertyOperation"]) {
    const types = eventTypesForPropertyOperation(this.spec.topic, propertyOperation)
    return {
      ...this.spec,
      ...(types ? { types } : {}),
      propertyOperation,
    }
  }
}

export function events<TObjectType extends ObjectTypeWithTokens>(
  objectType: TObjectType
): ObjectEventSelectorBuilder<TObjectType> {
  return new ObjectEventSelectorBuilderImpl(objectType, { objectTypeId: objectType.id })
}

function createPropertySelectorMap(
  tokens: Record<string, PropertyToken>,
  createSelector: (property: PropertyToken) => EventPropertySelector
): Record<string, EventPropertySelector> {
  return Object.fromEntries(
    Object.entries(tokens).map(([propertyId, token]) => [propertyId, createSelector(token)])
  )
}

function createLinkPropertyTokens(linkToken: LinkToken): Record<string, PropertyToken> {
  return Object.fromEntries(
    (linkToken.link.properties ?? []).map((property) => [
      property.id,
      {
        objectTypeId: linkToken.objectTypeId,
        id: property.id,
        property,
      } satisfies PropertyToken,
    ])
  )
}

function eventTypesForPropertyOperation(
  topic: EventSelectorSpec["topic"],
  propertyOperation: EventSelectorSpec["propertyOperation"]
): readonly DomainEvent["type"][] | undefined {
  if (topic === "objects") {
    return propertyOperation === "created"
      ? ["object.created", "object.updated"]
      : ["object.updated"]
  }
  if (topic === "links") {
    return propertyOperation === "created" ? ["link.created", "link.updated"] : ["link.updated"]
  }
  return undefined
}
