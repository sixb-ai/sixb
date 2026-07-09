import { describe, expect, test } from "bun:test"
import { buildEventSelectorPredicate, type DomainEvent, eventSelectorSpec, events } from "../src"
import { defineObjectType, link, prop } from "../src/ontology"

const Payment = defineObjectType({
  id: "Payment",
  name: "Payment",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double"),
    prop("status", "string"),
  ],
  links: [
    link.ref("payments", "Payment", {
      properties: [prop("amount", "double"), prop("currency", "string")],
    }),
  ],
})

function event(overrides: { type: string; topic: string } & Record<string, unknown>): DomainEvent {
  const { type, topic, ...rest } = overrides
  return {
    type,
    topic,
    payload: {},
    ...rest,
  } as unknown as DomainEvent
}

describe("events selector builder", () => {
  test("builds object mutation selectors", () => {
    expect(eventSelectorSpec(events(Invoice).created())).toEqual({
      objectTypeId: "Invoice",
      topic: "objects",
      types: ["object.created"],
    })

    expect(eventSelectorSpec(events(Invoice).p.amount.updated())).toEqual({
      objectTypeId: "Invoice",
      topic: "objects",
      types: ["object.updated"],
      propertyId: "amount",
      propertyOperation: "updated",
    })
  })

  test("builds link mutation selectors", () => {
    expect(eventSelectorSpec(events(Invoice).link(Invoice.l.payments).created())).toEqual({
      objectTypeId: "Invoice",
      topic: "links",
      types: ["link.created"],
      linkId: "payments",
    })

    expect(eventSelectorSpec(events(Invoice).link(Invoice.l.payments).p.amount.updated())).toEqual({
      objectTypeId: "Invoice",
      topic: "links",
      types: ["link.updated"],
      linkId: "payments",
      propertyId: "amount",
      propertyOperation: "updated",
    })
  })
})

describe("buildEventSelectorPredicate", () => {
  test("matches object property changes", () => {
    const matches = buildEventSelectorPredicate(events(Invoice).p.amount.updated())

    expect(
      matches(
        event({
          type: "object.updated",
          topic: "objects",
          payload: {
            objectTypeId: "Invoice",
            primaryId: "inv-1",
            properties: { amount: 700 },
            propertyChanges: {
              amount: { operation: "updated", before: 400, after: 700 },
            },
          },
        })
      )
    ).toBe(true)

    expect(
      matches(
        event({
          type: "object.updated",
          topic: "objects",
          payload: {
            objectTypeId: "Invoice",
            primaryId: "inv-1",
            properties: { status: "paid" },
            propertyChanges: {
              status: { operation: "updated", before: "draft", after: "paid" },
            },
          },
        })
      )
    ).toBe(false)
  })

  test("matches link property changes", () => {
    const matches = buildEventSelectorPredicate(
      events(Invoice).link(Invoice.l.payments).p.amount.created()
    )

    expect(
      matches(
        event({
          type: "link.created",
          topic: "links",
          payload: {
            sourceTypeId: "Invoice",
            sourceId: "inv-1",
            linkId: "payments",
            targetTypeId: Payment.id,
            targetId: "pay-1",
            properties: { amount: 700 },
            propertyChanges: {
              amount: { operation: "created", after: 700 },
            },
          },
        })
      )
    ).toBe(true)

    expect(
      matches(
        event({
          type: "link.created",
          topic: "links",
          payload: {
            sourceTypeId: "Invoice",
            sourceId: "inv-1",
            linkId: "refunds",
            targetTypeId: Payment.id,
            targetId: "pay-1",
            properties: { amount: 700 },
            propertyChanges: {
              amount: { operation: "created", after: 700 },
            },
          },
        })
      )
    ).toBe(false)
  })
})
