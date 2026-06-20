import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  commitActionEditBatch,
  defineObjectType,
  type EditBatch,
  link,
  OntologyRegistry,
  prop,
  type RecordEditsHandler,
  recordEdits,
} from "@sixb/core"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { required: true }),
  ],
  links: [
    link("customer", Customer, {
      cardinality: "one",
      properties: [prop("role", "string", { required: true })],
    }),
  ],
})

const Payment = defineObjectType({
  id: "Payment",
  name: "Payment",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("invoice", Invoice, { cardinality: "one" })],
})

const ontology = new OntologyRegistry({ sources: [Customer, Invoice, Payment] })

function recordStorageEdits(runId: string, handler: RecordEditsHandler): EditBatch {
  return recordEdits({ runId }, handler)
}

describe("PostgreSQL edit commit", () => {
  let storage: PostgresStorage | undefined

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    if (!storage) return
    await storage.dropSchema()
    await storage.close()
    storage = undefined
  })

  test("commits object and link updates with idempotent retry", async () => {
    if (!storage) throw new Error("[SixbPg] Test storage was not initialized.")

    await seedGraph(storage)
    await storage.actionRuns.queue({
      id: "run_mark_paid",
      projectId: "project-a",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_mark_paid",
    })
    await storage.actionRuns.start({
      id: "run_mark_paid",
      projectId: "project-a",
    })

    const batch = recordStorageEdits("run_mark_paid", ({ objects }) => {
      const invoice = objects(Invoice).byId("inv_1")

      invoice.update({ status: "paid" })
      invoice.link(Invoice.l.customer, objects(Customer).byId("cus_1"), {
        properties: { role: "payer" },
      })
    })

    const result = (
      await commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_mark_paid",
        actionId: "markPaid",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch,
        committedAt: new Date("2026-06-02T00:00:00.000Z"),
      })
    ).commit
    const retry = (
      await commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_mark_paid",
        actionId: "markPaid",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch,
      })
    ).commit

    const invoice = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Invoice",
      objectId: "inv_1",
      linkId: "customer",
    })

    expect(result.created).toBe(true)
    expect(retry.created).toBe(false)
    expect(invoice?.properties.status).toBe("paid")
    expect(invoice?.version).toBe(2)
    expect(links[0]?.properties).toEqual({ role: "payer" })
    expect(result.diff).toEqual({
      objects: [
        {
          objectTypeId: "Invoice",
          primaryId: "inv_1",
          operation: "update",
          changedProperties: ["status"],
        },
      ],
      links: [
        {
          operation: "update",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
      ],
    })
  })

  test("commits object delete with incident link diffs and idempotent retry", async () => {
    if (!storage) throw new Error("[SixbPg] Test storage was not initialized.")

    await seedGraph(storage)
    await storage.actionRuns.queue({
      id: "run_delete_invoice",
      projectId: "project-a",
      actionId: "deleteInvoice",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_delete_invoice",
    })
    await storage.actionRuns.start({
      id: "run_delete_invoice",
      projectId: "project-a",
    })

    const batch = recordStorageEdits("run_delete_invoice", ({ objects }) => {
      objects(Invoice).byId("inv_1").delete()
    })
    const result = (
      await commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_delete_invoice",
        actionId: "deleteInvoice",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch,
        committedAt: new Date("2026-06-02T00:00:00.000Z"),
      })
    ).commit
    const retry = (
      await commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_delete_invoice",
        actionId: "deleteInvoice",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch,
      })
    ).commit

    const invoice = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    const invoiceLinks = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Invoice",
      objectId: "inv_1",
      direction: "both",
    })
    const run = await storage.actionRuns.getById({
      projectId: "project-a",
      id: "run_delete_invoice",
    })

    expect(result.created).toBe(true)
    expect(retry.created).toBe(false)
    expect(invoice).toBeNull()
    expect(invoiceLinks).toEqual([])
    expect(run?.commit?.diff).toEqual(result.diff)
    expect(result.diff).toEqual({
      objects: [
        {
          objectTypeId: "Invoice",
          primaryId: "inv_1",
          operation: "delete",
          changedProperties: [],
        },
      ],
      links: [
        {
          operation: "delete",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
        {
          operation: "delete",
          source: { objectTypeId: "Payment", primaryId: "pay_1" },
          linkId: "invoice",
          target: { objectTypeId: "Invoice", primaryId: "inv_1" },
        },
      ],
    })
  })
})

async function seedGraph(storage: PostgresStorage): Promise<void> {
  const occurredAt = "2026-06-01T00:00:00.000Z"
  await storage.objects.applyObjectUpserted({
    id: "evt_customer",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Customer:cus_1",
    occurredAt,
    cursor: "evt_customer",
    payload: {
      objectTypeId: "Customer",
      primaryId: "cus_1",
      properties: { id: "cus_1", name: "Acme" },
    },
  })
  await storage.objects.applyObjectUpserted({
    id: "evt_invoice",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Invoice:inv_1",
    occurredAt,
    cursor: "evt_invoice",
    payload: {
      objectTypeId: "Invoice",
      primaryId: "inv_1",
      properties: { id: "inv_1", status: "draft" },
    },
  })
  await storage.objects.applyObjectUpserted({
    id: "evt_payment",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Payment:pay_1",
    occurredAt,
    cursor: "evt_payment",
    payload: {
      objectTypeId: "Payment",
      primaryId: "pay_1",
      properties: { id: "pay_1" },
    },
  })
  await storage.objects.applyLinkUpserted({
    id: "evt_invoice_customer",
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.upserted",
    topic: "links",
    partitionKey: "Invoice:inv_1:customer",
    occurredAt,
    cursor: "evt_invoice_customer",
    payload: {
      sourceTypeId: "Invoice",
      sourceId: "inv_1",
      linkId: "customer",
      targetTypeId: "Customer",
      targetId: "cus_1",
      properties: { role: "billTo" },
    },
  })
  await storage.objects.applyLinkUpserted({
    id: "evt_payment_invoice",
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.upserted",
    topic: "links",
    partitionKey: "Payment:pay_1:invoice",
    occurredAt,
    cursor: "evt_payment_invoice",
    payload: {
      sourceTypeId: "Payment",
      sourceId: "pay_1",
      linkId: "invoice",
      targetTypeId: "Invoice",
      targetId: "inv_1",
    },
  })
}
