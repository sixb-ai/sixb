import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineRule,
  defineSchedule,
  events,
  InMemoryBroker,
  link,
  OntologyRegistry,
  prop,
  ScheduleValidationError,
} from "../src"
import { DomainEventService } from "../src/events"
import type { OntologyMaterializationEvent } from "../src/materialization/events"
import { evaluateEventSchedule, validateSchedulesAtStartup } from "../src/schedules"

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

const invoiceAtRisk = defineRule("invoice.at-risk")
  .on(Invoice)
  .where((invoice) => invoice.p.amount.gt(500))

describe("evaluateEventSchedule", () => {
  test("returns the typed post-mutation context only on a false-to-true edge", async () => {
    const schedule = defineSchedule("invoice.high-value")
      .on(events.object(Invoice).updated())
      .where((event) => event.object.p.amount.gt(500))
    const runtime = new DomainEventService({ projectId: "test", broker: new InMemoryBroker() })
    const [crossed] = await runtime.publishEnvelopes([
      objectUpdatedFact("event-crossed", {
        objectTypeId: Invoice.id,
        primaryId: "inv-1",
        properties: { id: "inv-1", amount: 700 },
        propertyChanges: {
          amount: { operation: "updated", before: 400, after: 700 },
        },
      }),
    ])
    const [remainedTrue] = await runtime.publishEnvelopes([
      objectUpdatedFact("event-remained", {
        objectTypeId: Invoice.id,
        primaryId: "inv-1",
        properties: { id: "inv-1", amount: 800 },
        propertyChanges: {
          amount: { operation: "updated", before: 700, after: 800 },
        },
      }),
    ])

    expect(evaluateEventSchedule(schedule, crossed!)).toMatchObject({
      event: { object: { primaryId: "inv-1", p: { id: "inv-1", amount: 700 } } },
    })
    expect(evaluateEventSchedule(schedule, remainedTrue!)).toBeNull()
  })

  test("builds dataset occurrence context from the selected event", async () => {
    const invoices = { kind: "dataset", id: "raw.invoices" } as const
    const schedule = defineSchedule("invoices-updated").on(events.dataset(invoices).updated())
    const runtime = new DomainEventService({ projectId: "test", broker: new InMemoryBroker() })
    const [event] = await runtime.append({
      events: [
        {
          type: "dataset.version.committed",
          payload: {
            datasetId: invoices.id,
            versionId: "version-1",
            createdAt: "2026-01-01T00:00:00.000Z",
            producer: { kind: "sync", id: "sync-invoices", runId: "run-1" },
          },
        },
      ],
    })

    expect(evaluateEventSchedule(schedule, event!)?.event).toEqual({
      datasetId: invoices.id,
      versionId: "version-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { kind: "sync", id: "sync-invoices", runId: "run-1" },
    })
  })

  test("builds a member's occurrence context from the selected event", async () => {
    const schedule = defineSchedule("member-joined").on(events.users().joined())
    const runtime = new DomainEventService({ projectId: "test", broker: new InMemoryBroker() })
    const user = { id: "usr_ava", email: "ava@acme.com", status: "active" } as const
    const [joined, suspended] = await runtime.append({
      events: [
        { type: "user.joined", payload: { user, invitationId: "inv_ava" } },
        {
          type: "user.suspended",
          payload: { user, requestedBy: { type: "user", id: "usr_admin" } },
        },
      ],
    })

    expect(evaluateEventSchedule(schedule, joined!)?.event).toEqual({
      user,
      invitationId: "inv_ava",
    })
    expect(evaluateEventSchedule(schedule, suspended!)).toBeNull()
  })
})

function objectUpdatedFact(
  id: string,
  payload: (OntologyMaterializationEvent & { readonly type: "object.updated" })["payload"]
): OntologyMaterializationEvent {
  return {
    id,
    schemaVersion: 1,
    projectId: "test",
    occurredAt: "2026-01-01T00:00:00.000Z",
    correlationId: `correlation-${id}`,
    origin: { kind: "runtime", requestId: id },
    executor: { type: "request", requestId: id },
    commitId: `commit-${id}`,
    commitOrdinal: 0,
    type: "object.updated",
    topic: "objects",
    partitionKey: `${payload.objectTypeId}:${payload.primaryId}`,
    payload,
  }
}

describe("event schedules", () => {
  test("builds an inert link event schedule with an edge condition", () => {
    const schedule = defineSchedule("invoice.high-value-payment")
      .on(events.object(Invoice).link(Invoice.l.payments).created())
      .where((event) => event.link.p.amount.gt(500))

    expect(schedule).toEqual({
      kind: "schedule",
      id: "invoice.high-value-payment",
      trigger: {
        type: "event",
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
      },
    })
  })

  test("supports basic source-only schedules", () => {
    const schedule = defineSchedule("invoice.created").on(events.object(Invoice).created())

    expect(schedule).toMatchObject({
      kind: "schedule",
      id: "invoice.created",
      trigger: {
        type: "event",
        source: {
          objectTypeId: "Invoice",
          topic: "objects",
          types: ["object.created"],
        },
      },
    })
    expect(typeof schedule.where).toBe("function")
  })

  test("supports grouped object predicates", () => {
    const schedule = defineSchedule("invoice.high-value-usd")
      .on(events.object(Invoice).link(Invoice.l.payments).updated())
      .where((event) =>
        event.link.all(event.link.p.amount.gt(500), event.link.p.currency.eq("USD"))
      )

    expect(schedule.trigger.condition).toEqual({
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

  test("supports typed target identity predicates on links", () => {
    const schedule = defineSchedule("invoice.payment-target")
      .on(events.object(Invoice).link(Invoice.l.payments).created())
      .where((event) => event.link.all(event.target.is(Payment), event.target.id.eq("payment-1")))

    expect(schedule.trigger.condition).toEqual({
      kind: "becomesTrue",
      scope: "event.link",
      predicate: {
        kind: "all",
        predicates: [
          {
            kind: "field",
            field: "target.objectTypeId",
            op: "eq",
            value: "Payment",
          },
          {
            kind: "field",
            field: "target.primaryId",
            op: "eq",
            value: "payment-1",
          },
        ],
      },
    })
  })

  test("supports rule event sources without conditions", () => {
    const ruleSchedule = defineSchedule("invoice.at-risk-triggered").on(
      events.rule(invoiceAtRisk).triggered()
    )

    expect(ruleSchedule.trigger.source).toEqual({
      topic: "rules",
      types: ["rule.triggered"],
      ruleId: invoiceAtRisk.id,
    })
    expect("where" in ruleSchedule).toBe(false)
  })

  test("rejects non-terminal event selectors", () => {
    expect(() => defineSchedule("bad-source").on(events.object(Invoice))).toThrow(
      "Schedule event source must select an event operation"
    )
  })
})

describe("validateSchedulesAtStartup", () => {
  test("accepts link property and target identity predicates the ontology declares", () => {
    const schedules = [
      defineSchedule("invoice.high-value-payment")
        .on(events.object(Invoice).link(Invoice.l.payments).created())
        .where((event) => event.link.p.amount.gt(500)),
      defineSchedule("invoice.payment-target")
        .on(events.object(Invoice).link(Invoice.l.payments).created())
        .where((event) => event.target.is(Payment)),
    ]

    expect(() =>
      validateSchedulesAtStartup(schedules, new OntologyRegistry({ sources: [Invoice, Payment] }))
    ).not.toThrow()
  })

  test("rejects link target types outside the selected link", () => {
    const schedule = {
      kind: "schedule",
      id: "invoice.invalid-payment-target",
      trigger: {
        type: "event",
        source: events.object(Invoice).link(Invoice.l.payments).created(),
        condition: {
          kind: "becomesTrue",
          scope: "event.link",
          predicate: {
            kind: "field",
            field: "target.objectTypeId",
            op: "eq",
            value: "Invoice",
          },
        },
      },
    } as const

    expect(() =>
      validateSchedulesAtStartup([schedule], new OntologyRegistry({ sources: [Invoice, Payment] }))
    ).toThrow('object type "Invoice" is not a target of link "payments"')
  })

  test("rejects duplicate schedule ids", () => {
    const first = defineSchedule("duplicate").on(events.object(Invoice).created())
    const second = defineSchedule("duplicate").on(events.object(Invoice).updated())

    expect(() =>
      validateSchedulesAtStartup(
        [first, second],
        new OntologyRegistry({ sources: [Invoice, Payment] })
      )
    ).toThrow("Duplicate schedule id: duplicate")
  })

  test("rejects condition properties unknown to the selected link", () => {
    const schedule = {
      kind: "schedule",
      id: "bad-link-property",
      trigger: {
        type: "event",
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
      },
    } as const

    expect(() =>
      validateSchedulesAtStartup([schedule], new OntologyRegistry({ sources: [Invoice, Payment] }))
    ).toThrow('Schedule "bad-link-property": unknown property "missing" on link "payments"')
  })

  test("rejects unknown rule sources", () => {
    const ontology = new OntologyRegistry({ sources: [Invoice, Payment] })

    expect(() =>
      validateSchedulesAtStartup(
        [defineSchedule("invoice.at-risk-triggered").on(events.rule(invoiceAtRisk).triggered())],
        ontology
      )
    ).toThrow('unknown rule "invoice.at-risk"')
  })

  test("accepts registered rule, dataset, sync, and pipeline event sources", () => {
    const dataset = { kind: "dataset", id: "raw.invoices" } as const
    const sync = { kind: "sync", id: "import-invoices" } as const
    const pipeline = { kind: "pipeline", id: "normalize-invoices" } as const
    const schedules = [
      defineSchedule("invoice.at-risk-triggered").on(events.rule(invoiceAtRisk).triggered()),
      defineSchedule("invoices-updated").on(events.dataset(dataset).updated()),
      defineSchedule("import-succeeded").on(events.sync(sync).succeeded()),
      defineSchedule("normalization-failed").on(events.pipeline(pipeline).failed()),
    ]

    expect(() =>
      validateSchedulesAtStartup(schedules, new OntologyRegistry({ sources: [Invoice, Payment] }), {
        registeredRuleIds: new Set([invoiceAtRisk.id]),
        registeredDatasetIds: new Set([dataset.id]),
        registeredSyncIds: new Set([sync.id]),
        registeredPipelineIds: new Set([pipeline.id]),
      })
    ).not.toThrow()
  })

  test("validates member event sources", () => {
    const ontology = new OntologyRegistry({ sources: [Invoice, Payment] })

    expect(() =>
      validateSchedulesAtStartup(
        [defineSchedule("member-joined").on(events.users().joined())],
        ontology
      )
    ).not.toThrow()
    expect(() => defineSchedule("any-member-event").on(events.users())).toThrow(
      ScheduleValidationError
    )
    expect(() =>
      validateSchedulesAtStartup(
        [
          {
            kind: "schedule",
            id: "member-objects",
            trigger: { type: "event", source: { topic: "users", types: ["object.created"] } },
          },
        ],
        ontology
      )
    ).toThrow('unsupported member event type "object.created"')
  })
})
