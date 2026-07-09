import type { ActionDefinition } from "../../actions"
import type { LinkToken, ObjectTypeWithTokens, Property, PropertyToken } from "../../ontology"
import type { RuleDefinition } from "../../rules"
import type { DomainEvent } from "../types"
import type {
  ActionEventSelectorContext,
  ActionEventToken,
  ActionEventTokenOf,
  EventSelectorSpec,
  LinkEventSelectorContext,
  ObjectEventSelectorContext,
  RuleEventSelectorContext,
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

export interface RuleEventSelectorBuilder<TRule extends RuleDefinition>
  extends EventSelectorSpec<RuleEventSelectorContext<TRule>> {
  triggered(): EventSelectorSpec<RuleEventSelectorContext<TRule, "triggered">>
  resolved(): EventSelectorSpec<RuleEventSelectorContext<TRule, "resolved">>
}

export interface ActionEventSelectorBuilder<TAction extends ActionEventToken>
  extends EventSelectorSpec<ActionEventSelectorContext<TAction>> {
  requested(): EventSelectorSpec<ActionEventSelectorContext<TAction, "requested">>
  completed(): EventSelectorSpec<ActionEventSelectorContext<TAction, "completed">>
  failed(): EventSelectorSpec<ActionEventSelectorContext<TAction, "failed">>
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

  get ruleId(): EventSelectorSpec["ruleId"] {
    return this.spec.ruleId
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

class RuleEventSelectorBuilderImpl<TRule extends RuleDefinition>
  extends EventSelectorSpecView<RuleEventSelectorContext<TRule>>
  implements RuleEventSelectorBuilder<TRule>
{
  triggered(): EventSelectorSpec<RuleEventSelectorContext<TRule, "triggered">> {
    return this.withType("rule.triggered")
  }

  resolved(): EventSelectorSpec<RuleEventSelectorContext<TRule, "resolved">> {
    return this.withType("rule.resolved")
  }

  private withType<TOperation extends "triggered" | "resolved">(
    type: `rule.${TOperation}`
  ): EventSelectorSpec<RuleEventSelectorContext<TRule, TOperation>> {
    return { ...this.spec, types: [type] } as EventSelectorSpec<
      RuleEventSelectorContext<TRule, TOperation>
    >
  }
}

class ActionEventSelectorBuilderImpl<TAction extends ActionEventToken>
  extends EventSelectorSpecView<ActionEventSelectorContext<TAction>>
  implements ActionEventSelectorBuilder<TAction>
{
  requested(): EventSelectorSpec<ActionEventSelectorContext<TAction, "requested">> {
    return this.withType("action.requested")
  }

  completed(): EventSelectorSpec<ActionEventSelectorContext<TAction, "completed">> {
    return this.withType("action.completed")
  }

  failed(): EventSelectorSpec<ActionEventSelectorContext<TAction, "failed">> {
    return this.withType("action.failed")
  }

  private withType<TOperation extends "requested" | "completed" | "failed">(
    type: `action.${TOperation}`
  ): EventSelectorSpec<ActionEventSelectorContext<TAction, TOperation>> {
    return { ...this.spec, types: [type] } as EventSelectorSpec<
      ActionEventSelectorContext<TAction, TOperation>
    >
  }
}

function objectEvents<TObjectType extends ObjectTypeWithTokens>(
  objectType: TObjectType
): ObjectEventSelectorBuilder<TObjectType> {
  return new ObjectEventSelectorBuilderImpl(objectType, { objectTypeId: objectType.id })
}

export interface EventSelectors {
  <TObjectType extends ObjectTypeWithTokens>(
    objectType: TObjectType
  ): ObjectEventSelectorBuilder<TObjectType>
  rule<TRule extends RuleDefinition>(rule: TRule): RuleEventSelectorBuilder<TRule>
  action<TAction extends ActionDefinition>(
    action: TAction
  ): ActionEventSelectorBuilder<ActionEventTokenOf<TAction>>
}

export const events = Object.assign(objectEvents, {
  rule<TRule extends RuleDefinition>(rule: TRule): RuleEventSelectorBuilder<TRule> {
    return new RuleEventSelectorBuilderImpl({
      topic: "rules",
      ruleId: rule.id,
    } as EventSelectorSpec<RuleEventSelectorContext<TRule>>)
  },
  action<TAction extends ActionDefinition>(
    action: TAction
  ): ActionEventSelectorBuilder<ActionEventTokenOf<TAction>> {
    return new ActionEventSelectorBuilderImpl({
      topic: "actions",
      actionId: action.id,
    } as EventSelectorSpec<ActionEventSelectorContext<ActionEventTokenOf<TAction>>>)
  },
}) satisfies EventSelectors

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
