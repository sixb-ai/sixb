import { describe, expect, test } from "bun:test"
import {
  buildEventSelectorPredicate,
  col,
  type DomainEvent,
  defineAction,
  defineConnector,
  defineDataset,
  definePipeline,
  defineSync,
  eventSelectorSpec,
  events,
  param,
} from "../src"
import { defineObjectType, link, prop } from "../src/ontology"
import { defineRule } from "../src/rules"

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

const invoiceAtRisk = defineRule("invoice.at-risk")
  .on(Invoice)
  .where((invoice) => invoice.p.amount.gt(500))

const approveInvoice = defineAction("approve-invoice")
  .on(Invoice)
  .params({ reason: param("string") })
  .writeback(async () => {})

const rawInvoices = defineDataset("raw.invoices", {
  schema: [col("id", "string")],
})

const erp = defineConnector("erp", {
  type: "test",
  connect: () => ({}),
})

const importInvoices = defineSync("import-invoices")
  .from(erp)
  .read(() => [])
  .intoDataset(rawInvoices)

const normalizeInvoices = definePipeline("normalize-invoices")

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
    expect(eventSelectorSpec(events.object(Invoice).created())).toEqual({
      objectTypeId: "Invoice",
      topic: "objects",
      types: ["object.created"],
    })

    expect(eventSelectorSpec(events.object(Invoice).p.amount.updated())).toEqual({
      objectTypeId: "Invoice",
      topic: "objects",
      types: ["object.updated"],
      propertyId: "amount",
      propertyOperation: "updated",
    })

    expect(eventSelectorSpec(events.object(Invoice).p.amount.created())).toEqual({
      objectTypeId: "Invoice",
      topic: "objects",
      types: ["object.created", "object.updated"],
      propertyId: "amount",
      propertyOperation: "created",
    })
  })

  test("builds link mutation selectors", () => {
    expect(eventSelectorSpec(events.object(Invoice).link(Invoice.l.payments).created())).toEqual({
      objectTypeId: "Invoice",
      topic: "links",
      types: ["link.created"],
      linkId: "payments",
    })

    expect(
      eventSelectorSpec(events.object(Invoice).link(Invoice.l.payments).p.amount.updated())
    ).toEqual({
      objectTypeId: "Invoice",
      topic: "links",
      types: ["link.updated"],
      linkId: "payments",
      propertyId: "amount",
      propertyOperation: "updated",
    })
  })

  test("builds rule and action selectors from definition tokens", () => {
    expect(eventSelectorSpec(events.rule(invoiceAtRisk).triggered())).toEqual({
      topic: "rules",
      types: ["rule.triggered"],
      ruleId: "invoice.at-risk",
    })

    expect(eventSelectorSpec(events.action(approveInvoice).completed())).toEqual({
      topic: "actions",
      types: ["action.completed"],
      actionId: "approve-invoice",
    })
  })

  test("builds dataset, sync, and pipeline selectors from definition tokens", () => {
    expect(eventSelectorSpec(events.dataset(rawInvoices).updated())).toEqual({
      topic: "datasets",
      types: ["dataset.version.committed"],
      datasetId: "raw.invoices",
    })
    expect(eventSelectorSpec(events.sync(importInvoices).succeeded())).toEqual({
      topic: "syncs",
      types: ["sync.run.finished"],
      syncId: "import-invoices",
      runStatus: "succeeded",
    })
    expect(eventSelectorSpec(events.pipeline(normalizeInvoices).failed())).toEqual({
      topic: "pipelines",
      types: ["pipeline.run.finished"],
      pipelineId: "normalize-invoices",
      runStatus: "failed",
    })
  })
})

describe("buildEventSelectorPredicate", () => {
  test("matches object property changes", () => {
    const matches = buildEventSelectorPredicate(events.object(Invoice).p.amount.updated())

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

  test("matches a property created on an existing object", () => {
    const matches = buildEventSelectorPredicate(events.object(Invoice).p.amount.created())

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
              amount: { operation: "created", after: 700 },
            },
          },
        })
      )
    ).toBe(true)
  })

  test("matches link property changes", () => {
    const matches = buildEventSelectorPredicate(
      events.object(Invoice).link(Invoice.l.payments).p.amount.created()
    )

    expect(
      matches(
        event({
          type: "link.updated",
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

  test("matches rule and action definition ids", () => {
    const matchesRule = buildEventSelectorPredicate(events.rule(invoiceAtRisk).triggered())
    const matchesAction = buildEventSelectorPredicate(events.action(approveInvoice).completed())

    expect(
      matchesRule(
        event({
          type: "rule.triggered",
          topic: "rules",
          payload: {
            ruleId: invoiceAtRisk.id,
            subject: { kind: "object", objectTypeId: Invoice.id, primaryId: "inv-1" },
            triggeredAt: "2026-07-09T18:00:00.000Z",
          },
        })
      )
    ).toBe(true)
    expect(
      matchesRule(
        event({
          type: "rule.triggered",
          topic: "rules",
          payload: {
            ruleId: "invoice.other",
            subject: { kind: "object", objectTypeId: Invoice.id, primaryId: "inv-1" },
            triggeredAt: "2026-07-09T18:00:00.000Z",
          },
        })
      )
    ).toBe(false)

    expect(
      matchesAction(
        event({
          type: "action.completed",
          topic: "actions",
          payload: {
            actionId: approveInvoice.id,
            runId: "run-1",
            subject: { kind: "object", objectTypeId: Invoice.id, primaryId: "inv-1" },
            finishedAt: "2026-07-09T18:00:00.000Z",
          },
        })
      )
    ).toBe(true)
  })

  test("matches typed run outcomes", () => {
    const matches = buildEventSelectorPredicate(events.sync(importInvoices).succeeded())

    expect(
      matches(
        event({
          type: "sync.run.finished",
          topic: "syncs",
          payload: {
            syncId: importInvoices.id,
            runId: "run-1",
            status: "succeeded",
          },
        })
      )
    ).toBe(true)
    expect(
      matches(
        event({
          type: "sync.run.finished",
          topic: "syncs",
          payload: {
            syncId: importInvoices.id,
            runId: "run-2",
            status: "failed",
          },
        })
      )
    ).toBe(false)
  })
})
