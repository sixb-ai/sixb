import { describe, expect, test } from "bun:test"
import {
  buildLinkRemovedEvents,
  buildObjectDeletedEvents,
  buildObjectUpsertEvents,
  EventsRuntime,
  InMemoryBroker,
  scopeKeysForEvent,
} from "../src"

describe("object/link event drafts", () => {
  test("carries typed mutation origin instead of generic metadata", () => {
    const [, event] = buildObjectUpsertEvents({
      objectTypeId: "Invoice",
      primaryId: "inv-1",
      operation: "update",
      properties: { amount: 700 },
      previousProperties: { amount: 400 },
      origin: {
        kind: "action",
        actionId: "approveInvoice",
        runId: "act-1",
      },
    })

    expect(event.origin).toEqual({
      kind: "action",
      actionId: "approveInvoice",
      runId: "act-1",
    })
    expect(event).not.toHaveProperty("metadata")
  })

  test("builds deleted mutation events from previous properties", () => {
    expect(
      buildObjectDeletedEvents({
        objectTypeId: "Invoice",
        primaryId: "inv-1",
        previousProperties: { amount: 700 },
      })[0]
    ).toMatchObject({
      type: "object.deleted",
      payload: {
        propertyChanges: {
          amount: { operation: "cleared", before: 700, after: null },
        },
      },
    })

    expect(
      buildLinkRemovedEvents({
        sourceTypeId: "Invoice",
        sourceId: "inv-1",
        linkId: "payments",
        targetTypeId: "Payment",
        targetId: "pay-1",
        previousProperties: { amount: 700 },
      })[1]
    ).toMatchObject({
      type: "link.deleted",
      payload: {
        propertyChanges: {
          amount: { operation: "cleared", before: 700, after: null },
        },
      },
    })
  })

  test("stores object.updated with property changes", async () => {
    const events = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    const [event] = await events.append({
      events: [
        {
          type: "object.updated",
          origin: { kind: "action", actionId: "approveInvoice", runId: "act-1" },
          payload: {
            objectTypeId: "Invoice",
            primaryId: "inv-1",
            properties: { amount: 700 },
            propertyChanges: {
              amount: { operation: "updated", before: 400, after: 700 },
            },
          },
        },
      ],
    })

    expect(event).toMatchObject({
      type: "object.updated",
      topic: "objects",
      partitionKey: "Invoice:inv-1",
      origin: { kind: "action", actionId: "approveInvoice", runId: "act-1" },
    })
    expect(event ? scopeKeysForEvent(event) : undefined).toEqual({
      objectTypeId: "Invoice",
      primaryId: "inv-1",
    })
  })

  test("stores object.deleted with cleared property changes", async () => {
    const events = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    const [event] = await events.append({
      events: [
        {
          type: "object.deleted",
          payload: {
            objectTypeId: "Invoice",
            primaryId: "inv-1",
            propertyChanges: {
              amount: { operation: "cleared", before: 700, after: null },
            },
          },
        },
      ],
    })

    expect(event).toMatchObject({
      type: "object.deleted",
      topic: "objects",
      partitionKey: "Invoice:inv-1",
    })
  })

  test("stores link.created with link property changes", async () => {
    const events = new EventsRuntime({ projectId: "project-a", broker: new InMemoryBroker() })
    const [event] = await events.append({
      events: [
        {
          type: "link.created",
          payload: {
            sourceTypeId: "Invoice",
            sourceId: "inv-1",
            linkId: "payments",
            targetTypeId: "Payment",
            targetId: "pay-1",
            properties: { amount: 700 },
            propertyChanges: {
              amount: { operation: "created", after: 700 },
            },
          },
        },
      ],
    })

    expect(event).toMatchObject({
      type: "link.created",
      topic: "links",
      partitionKey: "Invoice:inv-1:payments",
    })
    expect(event ? scopeKeysForEvent(event) : undefined).toEqual({
      objectTypeId: "Invoice",
      primaryId: "inv-1",
      linkId: "payments",
    })
  })
})
