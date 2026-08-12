import { describe, expect, test } from "bun:test"
import { InMemoryBroker } from "../src"
import { DomainEventService } from "../src/events"
import { scopeKeysForEvent } from "../src/events/scope"
import type { OntologyMaterializationEvent } from "../src/materialization/events"

describe("materialized object/link event envelopes", () => {
  test("stores object.updated with property changes", async () => {
    const events = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    const [event] = await events.publishEnvelopes([
      materializationFact(
        {
          type: "object.updated",
          topic: "objects",
          partitionKey: "Invoice:inv-1",
          payload: {
            objectTypeId: "Invoice",
            primaryId: "inv-1",
            properties: { amount: 700 },
            propertyChanges: {
              amount: { operation: "updated", before: 400, after: 700 },
            },
          },
        },
        { kind: "action", actionId: "approveInvoice", runId: "act-1" }
      ),
    ])

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
    const events = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    const [event] = await events.publishEnvelopes([
      materializationFact({
        type: "object.deleted",
        topic: "objects",
        partitionKey: "Invoice:inv-1",
        payload: {
          objectTypeId: "Invoice",
          primaryId: "inv-1",
          propertyChanges: {
            amount: { operation: "cleared", before: 700, after: null },
          },
        },
      }),
    ])

    expect(event).toMatchObject({
      type: "object.deleted",
      topic: "objects",
      partitionKey: "Invoice:inv-1",
    })
  })

  test("stores link.created with link property changes", async () => {
    const events = new DomainEventService({ projectId: "project-a", broker: new InMemoryBroker() })
    const [event] = await events.publishEnvelopes([
      materializationFact({
        type: "link.created",
        topic: "links",
        partitionKey: "Invoice:inv-1:payments",
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
      }),
    ])

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

function materializationFact(
  input: Pick<OntologyMaterializationEvent, "type" | "topic" | "partitionKey" | "payload">,
  origin: OntologyMaterializationEvent["origin"] = {
    kind: "runtime",
    requestId: "request-1",
  }
): OntologyMaterializationEvent {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    projectId: "project-a",
    occurredAt: "2026-01-01T00:00:00.000Z",
    origin,
    commitId: "commit-1",
    commitOrdinal: 0,
    ...input,
  } as OntologyMaterializationEvent
}
