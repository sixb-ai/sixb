import type { LinkToken, ObjectTypeWithTokens, Property, PropertyToken } from "../../ontology"
import type { DomainEvent } from "../types"
import type {
  EventSelectorSpec,
  LinkEventSelectorContext,
  ObjectEventSelectorContext,
} from "./types"

type EventPropertySelectorMap<TTokens, TContext> = {
  readonly [K in keyof TTokens]: TTokens[K] extends PropertyToken
    ? EventPropertySelector<TContext>
    : never
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
  extends EventSelectorSpec<ObjectEventSelectorContext<TObjectType>> {
  readonly p: EventPropertySelectorMap<TObjectType["p"], ObjectEventSelectorContext<TObjectType>>

  created(): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>>
  updated(): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>>
  deleted(): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>>

  link<TLink extends LinkToken<TObjectType["id"]>>(
    link: TLink
  ): LinkEventSelectorBuilder<TObjectType, TLink>
}

export interface LinkEventSelectorBuilder<
  TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken<TObjectType["id"]>,
> extends EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> {
  readonly p: EventPropertySelectorMap<
    LinkPropertyTokens<TLink>,
    LinkEventSelectorContext<TObjectType, TLink>
  >

  created(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>>
  updated(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>>
  deleted(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>>
  /** @deprecated Use `.deleted()` instead. */
  removed(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>>
}

export interface EventPropertySelector<TContext = unknown> extends EventSelectorSpec<TContext> {
  created(): EventSelectorSpec<TContext>
  updated(): EventSelectorSpec<TContext>
  cleared(): EventSelectorSpec<TContext>
}

abstract class EventSelectorSpecView<TContext> implements EventSelectorSpec<TContext> {
  constructor(protected readonly spec: EventSelectorSpec<TContext>) {}

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
  extends EventSelectorSpecView<ObjectEventSelectorContext<TObjectType>>
  implements ObjectEventSelectorBuilder<TObjectType>
{
  constructor(
    private readonly objectType: TObjectType,
    spec: EventSelectorSpec<ObjectEventSelectorContext<TObjectType>>
  ) {
    super(spec)
  }

  get p(): EventPropertySelectorMap<TObjectType["p"], ObjectEventSelectorContext<TObjectType>> {
    return createPropertySelectorMap(
      this.objectType.p,
      (property) =>
        new EventPropertySelectorImpl({
          ...this.spec,
          topic: "objects",
          propertyId: property.id,
        })
    ) as EventPropertySelectorMap<TObjectType["p"], ObjectEventSelectorContext<TObjectType>>
  }

  created(): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>> {
    return this.withObjectEventType("object.created")
  }

  updated(): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>> {
    return this.withObjectEventType("object.updated")
  }

  deleted(): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>> {
    return this.withObjectEventType("object.deleted")
  }

  link<TLink extends LinkToken<TObjectType["id"]>>(
    link: TLink
  ): LinkEventSelectorBuilder<TObjectType, TLink> {
    const spec = {
      ...this.spec,
      topic: "links",
      linkId: link.id,
    } as EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>>

    return new LinkEventSelectorBuilderImpl(link, spec)
  }

  private withObjectEventType(
    type: "object.created" | "object.updated" | "object.deleted"
  ): EventSelectorSpec<ObjectEventSelectorContext<TObjectType>> {
    const spec: EventSelectorSpec<ObjectEventSelectorContext<TObjectType>> = {
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
  extends EventSelectorSpecView<LinkEventSelectorContext<TObjectType, TLink>>
  implements LinkEventSelectorBuilder<TObjectType, TLink>
{
  constructor(
    private readonly linkToken: TLink,
    spec: EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>>
  ) {
    super(spec)
  }

  get p(): EventPropertySelectorMap<
    LinkPropertyTokens<TLink>,
    LinkEventSelectorContext<TObjectType, TLink>
  > {
    return createPropertySelectorMap(
      createLinkPropertyTokens(this.linkToken),
      (property) =>
        new EventPropertySelectorImpl({
          ...this.spec,
          topic: "links",
          propertyId: property.id,
        })
    ) as EventPropertySelectorMap<
      LinkPropertyTokens<TLink>,
      LinkEventSelectorContext<TObjectType, TLink>
    >
  }

  created(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> {
    return this.withLinkEventType("link.created")
  }

  updated(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> {
    return this.withLinkEventType("link.updated")
  }

  deleted(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> {
    return this.withLinkEventType("link.deleted")
  }

  removed(): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> {
    return this.deleted()
  }

  private withLinkEventType(
    type: "link.created" | "link.updated" | "link.deleted"
  ): EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> {
    const spec: EventSelectorSpec<LinkEventSelectorContext<TObjectType, TLink>> = {
      ...this.spec,
      topic: "links",
      types: [type],
    }
    return spec
  }
}

class EventPropertySelectorImpl<TContext>
  extends EventSelectorSpecView<TContext>
  implements EventPropertySelector<TContext>
{
  created(): EventSelectorSpec<TContext> {
    return this.withPropertyOperation("created")
  }

  updated(): EventSelectorSpec<TContext> {
    return this.withPropertyOperation("updated")
  }

  cleared(): EventSelectorSpec<TContext> {
    return this.withPropertyOperation("cleared")
  }

  private withPropertyOperation(
    propertyOperation: EventSelectorSpec["propertyOperation"]
  ): EventSelectorSpec<TContext> {
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
  createSelector: (property: PropertyToken) => EventPropertySelector<unknown>
): Record<string, EventPropertySelector<unknown>> {
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
