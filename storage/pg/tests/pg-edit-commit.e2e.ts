import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  commitActionEditBatch,
  defineObjectType,
  type EditBatch,
  link,
  type ObjectStorage,
  ObjectStorageError,
  OntologyRegistry,
  planEditBatch,
  prop,
  type Storage,
  type StoredObjectUpsertedEvent,
} from "@sixb/core"
import { type RecordEditsHandler, recordEdits } from "@sixb/core/internal/edits"
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

async function recordStorageEdits(runId: string, handler: RecordEditsHandler): Promise<EditBatch> {
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

    const batch = await recordStorageEdits("run_mark_paid", ({ objects }) => {
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

    const batch = await recordStorageEdits("run_delete_invoice", ({ objects }) => {
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

  test("rejects a create whose object already exists with a typed, identified error", async () => {
    if (!storage) throw new Error("[SixbPg] Test storage was not initialized.")
    const objects = storage.objects

    // The net-diff planner never emits a `create` for a live row, so build the plan while the row is
    // absent; applying twice reproduces the concurrent-create hazard. Postgres must report the same
    // typed, per-entity error as the other providers rather than a generic count-mismatch message.
    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage: { objects },
      batch: {
        version: 1,
        operations: [
          {
            kind: "object.create",
            objectTypeId: "Invoice",
            primaryId: "inv_dup",
            properties: { id: "inv_dup", status: "draft" },
          },
        ],
      },
    })
    expect(plan.objects.upserts[0]?.operation).toBe("create")

    const applyAgain = () =>
      objects.applyEditCommitPlan({
        projectId: "project-a",
        plan,
        committedAt: new Date("2026-06-03T00:00:00.000Z"),
      })

    await objects.applyEditCommitPlan({
      projectId: "project-a",
      plan,
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })

    await expect(applyAgain()).rejects.toThrow(ObjectStorageError)
    await expect(applyAgain()).rejects.toThrow(
      "[Sixb] Edit commit cannot create existing object 'Invoice:inv_dup'."
    )
  })

  test("rejects a create whose link already exists with a typed, identified error", async () => {
    if (!storage) throw new Error("[SixbPg] Test storage was not initialized.")
    const objects = storage.objects

    // Seed only the endpoints (no link) so the plan nets to a link `create`.
    await objects.applyObjectUpserted(
      objectEvent("Customer", "cus_1", { id: "cus_1", name: "Acme" })
    )
    await objects.applyObjectUpserted(
      objectEvent("Invoice", "inv_1", { id: "inv_1", status: "draft" })
    )

    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage: { objects },
      batch: {
        version: 1,
        operations: [
          {
            kind: "link.create",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
            properties: { role: "billTo" },
          },
        ],
      },
    })
    expect(plan.links.upserts[0]?.operation).toBe("create")

    const applyAgain = () =>
      objects.applyEditCommitPlan({
        projectId: "project-a",
        plan,
        committedAt: new Date("2026-06-03T00:00:00.000Z"),
      })

    await objects.applyEditCommitPlan({
      projectId: "project-a",
      plan,
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })

    await expect(applyAgain()).rejects.toThrow(ObjectStorageError)
    await expect(applyAgain()).rejects.toThrow(
      "[Sixb] Edit commit cannot create existing link 'Invoice:inv_1:customer:Customer:cus_1'."
    )
  })

  test("serializable commits prevent concurrent cardinality-one link conflicts", async () => {
    if (!storage) throw new Error("[SixbPg] Test storage was not initialized.")

    await seedInvoiceAndCustomers(storage)
    await queueRunningActionRun(storage, "run_link_cus_1")
    await queueRunningActionRun(storage, "run_link_cus_2")

    const storageWithBarrier = withApplyEditCommitPlanBarrier(storage, 2)
    const batchA = await recordStorageEdits("run_link_cus_1", ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, objects(Customer).byId("cus_1"), {
          properties: { role: "payer" },
        })
    })
    const batchB = await recordStorageEdits("run_link_cus_2", ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, objects(Customer).byId("cus_2"), {
          properties: { role: "payer" },
        })
    })

    const results = await Promise.allSettled([
      commitActionEditBatch({
        storage: storageWithBarrier,
        projectId: "project-a",
        runId: "run_link_cus_1",
        actionId: "linkCustomer",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch: batchA,
      }),
      commitActionEditBatch({
        storage: storageWithBarrier,
        projectId: "project-a",
        runId: "run_link_cus_2",
        actionId: "linkCustomer",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch: batchB,
      }),
    ])

    const fulfilled = results.filter(isPromiseFulfilled)
    const rejected = results.filter(isPromiseRejected)
    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Invoice",
      objectId: "inv_1",
      linkId: "customer",
    })
    const runs = await Promise.all([
      storage.actionRuns.getById({ projectId: "project-a", id: "run_link_cus_1" }),
      storage.actionRuns.getById({ projectId: "project-a", id: "run_link_cus_2" }),
    ])

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(Error)
    expect((rejected[0]?.reason as Error).message).toContain("cardinality 'one'")
    expect(links).toHaveLength(1)
    expect(["cus_1", "cus_2"]).toContain(links[0]?.targetId)
    expect(runs.filter((run) => run?.commit !== undefined)).toHaveLength(1)
  })
})

function objectEvent(
  objectTypeId: string,
  primaryId: string,
  properties: Record<string, unknown>
): StoredObjectUpsertedEvent {
  const id = `evt_${objectTypeId}_${primaryId}`
  return {
    id,
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: `${objectTypeId}:${primaryId}`,
    occurredAt: "2026-06-01T00:00:00.000Z",
    cursor: id,
    payload: { objectTypeId, primaryId, properties },
  }
}

function withApplyEditCommitPlanBarrier(storage: PostgresStorage, parties: number): Storage {
  const waitForConcurrentCommits = createOneShotBarrier(parties)
  return {
    ...storage,
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const objects = createObjectStorageApplyBarrier(tx.objects, waitForConcurrentCommits)
        return run({ ...tx, objects })
      }, options),
  }
}

function createObjectStorageApplyBarrier(
  objects: ObjectStorage,
  waitForConcurrentCommits: () => Promise<void>
): ObjectStorage {
  return new Proxy(objects, {
    get(target, property, receiver) {
      if (property === "applyEditCommitPlan") {
        return async (input: Parameters<ObjectStorage["applyEditCommitPlan"]>[0]) => {
          await waitForConcurrentCommits()
          return target.applyEditCommitPlan(input)
        }
      }

      const value = Reflect.get(target, property, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function createOneShotBarrier(parties: number): () => Promise<void> {
  let waiting = 0
  let released = false
  let release: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })

  return async () => {
    if (released) return

    waiting++
    if (waiting >= parties) {
      released = true
      release()
    }

    await ready
  }
}

function isPromiseFulfilled<T>(
  result: PromiseSettledResult<T>
): result is PromiseFulfilledResult<T> {
  return result.status === "fulfilled"
}

function isPromiseRejected<T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult {
  return result.status === "rejected"
}

async function queueRunningActionRun(storage: PostgresStorage, runId: string): Promise<void> {
  await storage.actionRuns.queue({
    id: runId,
    projectId: "project-a",
    actionId: "linkCustomer",
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
    params: {},
    idempotencyKey: `action:project-a:${runId}`,
  })
  await storage.actionRuns.start({
    id: runId,
    projectId: "project-a",
  })
}

async function seedInvoiceAndCustomers(storage: PostgresStorage): Promise<void> {
  const occurredAt = "2026-06-01T00:00:00.000Z"
  await storage.objects.applyObjectUpserted({
    id: "evt_customer_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Customer:cus_1",
    occurredAt,
    cursor: "evt_customer_1",
    payload: {
      objectTypeId: "Customer",
      primaryId: "cus_1",
      properties: { id: "cus_1", name: "Acme" },
    },
  })
  await storage.objects.applyObjectUpserted({
    id: "evt_customer_2",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Customer:cus_2",
    occurredAt,
    cursor: "evt_customer_2",
    payload: {
      objectTypeId: "Customer",
      primaryId: "cus_2",
      properties: { id: "cus_2", name: "Globex" },
    },
  })
  await storage.objects.applyObjectUpserted({
    id: "evt_invoice_without_customer",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Invoice:inv_1",
    occurredAt,
    cursor: "evt_invoice_without_customer",
    payload: {
      objectTypeId: "Invoice",
      primaryId: "inv_1",
      properties: { id: "inv_1", status: "draft" },
    },
  })
}

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
