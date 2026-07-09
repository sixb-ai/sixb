import { describe, expect, test } from "bun:test"
import {
  datasetUpdated,
  defineObjectType,
  defineTrigger,
  events,
  isRunTrigger,
  link,
  OntologyRegistry,
  pipelineFinished,
  prop,
  syncFinished,
  TriggerValidationError,
  validateTriggersAtStartup,
} from "../src"

const Payment = defineObjectType({
  id: "Payment",
  name: "Payment",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true }), prop("amount", "double")],
  links: [
    link("payments", Payment, {
      cardinality: "many",
      properties: [prop("amount", "double"), prop("currency", "string")],
    }),
  ],
})

describe("syncFinished", () => {
  test("returns a sync.finished trigger", () => {
    expect(syncFinished("sync-orders")).toEqual({
      type: "sync.finished",
      syncId: "sync-orders",
      status: "succeeded",
    })
  })

  test("rejects empty syncId", () => {
    expect(() => syncFinished("")).toThrow(TriggerValidationError)
    expect(() => syncFinished("   ")).toThrow("Trigger syncId must not be empty")
  })
})

describe("pipelineFinished", () => {
  test("returns a pipeline.finished trigger", () => {
    expect(pipelineFinished("normalize-orders")).toEqual({
      type: "pipeline.finished",
      pipelineId: "normalize-orders",
      status: "succeeded",
    })
  })

  test("rejects empty pipelineId", () => {
    expect(() => pipelineFinished("")).toThrow(TriggerValidationError)
    expect(() => pipelineFinished("  ")).toThrow("Trigger pipelineId must not be empty")
  })
})

describe("datasetUpdated", () => {
  test("returns a dataset.updated trigger", () => {
    expect(datasetUpdated("raw.erp.orders")).toEqual({
      type: "dataset.updated",
      datasetId: "raw.erp.orders",
    })
  })

  test("rejects empty datasetId", () => {
    expect(() => datasetUpdated("")).toThrow(TriggerValidationError)
    expect(() => datasetUpdated("  ")).toThrow("Trigger datasetId must not be empty")
  })
})

describe("isRunTrigger", () => {
  test("returns true for valid schedule trigger", () => {
    expect(isRunTrigger({ type: "schedule", scheduleId: "daily" })).toBe(true)
  })

  test("returns true for valid sync.finished trigger", () => {
    expect(isRunTrigger({ type: "sync.finished", syncId: "s1", status: "succeeded" })).toBe(true)
  })

  test("returns true for valid pipeline.finished trigger", () => {
    expect(isRunTrigger({ type: "pipeline.finished", pipelineId: "p1", status: "succeeded" })).toBe(
      true
    )
  })

  test("returns true for valid dataset.updated trigger", () => {
    expect(isRunTrigger({ type: "dataset.updated", datasetId: "raw.orders" })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isRunTrigger(null)).toBe(false)
  })

  test("returns false for unknown type", () => {
    expect(isRunTrigger({ type: "unknown", id: "x" })).toBe(false)
  })

  test("returns false for missing required fields", () => {
    expect(isRunTrigger({ type: "schedule" })).toBe(false)
    expect(isRunTrigger({ type: "sync.finished", syncId: "s1" })).toBe(false)
    expect(isRunTrigger({ type: "dataset.updated" })).toBe(false)
  })
})

describe("defineTrigger", () => {
  test("builds an inert link trigger with an edge condition", () => {
    const trigger = defineTrigger("invoice.high-value-payment")
      .on(events(Invoice).link(Invoice.l.payments).created())
      .where((event) => event.link.p.amount.gt(500))

    expect(trigger).toEqual({
      kind: "trigger",
      id: "invoice.high-value-payment",
      source: {
        objectTypeId: "Invoice",
        topic: "links",
        types: ["link.created"],
        linkId: "payments",
      },
      condition: {
        kind: "becomesTrue",
        scope: "event.link",
        predicate: {
          kind: "property",
          propertyId: "amount",
          op: "gt",
          value: 500,
        },
      },
    })
  })

  test("supports basic source-only triggers", () => {
    const trigger = defineTrigger("invoice.created").on(events(Invoice).created())

    expect(trigger).toMatchObject({
      kind: "trigger",
      id: "invoice.created",
      source: {
        objectTypeId: "Invoice",
        topic: "objects",
        types: ["object.created"],
      },
    })
    expect(typeof trigger.where).toBe("function")
  })

  test("supports grouped object predicates", () => {
    const trigger = defineTrigger("invoice.high-value-usd")
      .on(events(Invoice).link(Invoice.l.payments).updated())
      .where((event) =>
        event.link.all(event.link.p.amount.gt(500), event.link.p.currency.eq("USD"))
      )

    expect(trigger.condition).toEqual({
      kind: "becomesTrue",
      scope: "event.link",
      predicate: {
        kind: "all",
        predicates: [
          { kind: "property", propertyId: "amount", op: "gt", value: 500 },
          { kind: "property", propertyId: "currency", op: "eq", value: "USD" },
        ],
      },
    })
  })

  test("rejects empty ids and non-terminal event selectors", () => {
    expect(() => defineTrigger("")).toThrow(TriggerValidationError)
    expect(() => defineTrigger("bad-source").on(events(Invoice))).toThrow(
      "Trigger source must select an event operation"
    )
  })
})

describe("validateTriggersAtStartup", () => {
  test("accepts triggers that reference known ontology fields", () => {
    const trigger = defineTrigger("invoice.high-value-payment")
      .on(events(Invoice).link(Invoice.l.payments).created())
      .where((event) => event.link.p.amount.gt(500))

    expect(() =>
      validateTriggersAtStartup([trigger], new OntologyRegistry({ sources: [Invoice, Payment] }))
    ).not.toThrow()
  })

  test("rejects duplicate trigger ids", () => {
    const first = defineTrigger("duplicate").on(events(Invoice).created())
    const second = defineTrigger("duplicate").on(events(Invoice).updated())

    expect(() =>
      validateTriggersAtStartup(
        [first, second],
        new OntologyRegistry({ sources: [Invoice, Payment] })
      )
    ).toThrow("Duplicate trigger id: duplicate")
  })

  test("rejects condition properties unknown to the selected link", () => {
    const trigger = {
      kind: "trigger",
      id: "bad-link-property",
      source: {
        objectTypeId: "Invoice",
        topic: "links",
        types: ["link.created"],
        linkId: "payments",
      },
      condition: {
        kind: "becomesTrue",
        scope: "event.link",
        predicate: {
          kind: "property",
          propertyId: "missing",
          op: "eq",
          value: "x",
        },
      },
    } as const

    expect(() =>
      validateTriggersAtStartup([trigger], new OntologyRegistry({ sources: [Invoice, Payment] }))
    ).toThrow('Trigger "bad-link-property": unknown property "missing" on link "payments"')
  })
})
