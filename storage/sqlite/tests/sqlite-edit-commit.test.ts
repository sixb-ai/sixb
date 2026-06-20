import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  commitActionEditBatch,
  defineObjectType,
  type EditBatch,
  link,
  migrateStorage,
  ObjectStorageError,
  OntologyRegistry,
  planEditBatch,
  prop,
  type StoredObjectUpsertedEvent,
} from "@sixb/core"
import { type RecordEditsHandler, recordEdits } from "@sixb/core/actions/worker"
import { SqliteStorage } from "../src"

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
const tempDirs: string[] = []

async function recordStorageEdits(runId: string, handler: RecordEditsHandler): Promise<EditBatch> {
  return recordEdits({ runId }, handler)
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe("SQLite edit commit", () => {
  test("commits object and link updates with idempotent retry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-edit-commit-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    try {
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
    } finally {
      closeSqliteStorage(storage)
    }
  })

  test("commits object delete with incident link diffs and idempotent retry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-edit-commit-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    try {
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
    } finally {
      closeSqliteStorage(storage)
    }
  })
})

describe("SQLite edit commit apply conflicts", () => {
  test("rejects a create whose object already exists with a typed, identified error", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-edit-conflict-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    try {
      // The net-diff planner never emits a `create` for a live row, so build the plan while the row
      // is absent; applying twice reproduces the concurrent-create hazard. Before this fix SQLite
      // leaked a raw SQLITE_CONSTRAINT driver error here instead of a typed ObjectStorageError.
      const plan = await planEditBatch({
        projectId: "project-a",
        ontology,
        storage: { objects: storage.objects },
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
        storage.objects.applyEditCommitPlan({
          projectId: "project-a",
          plan,
          committedAt: new Date("2026-06-03T00:00:00.000Z"),
        })

      await storage.objects.applyEditCommitPlan({
        projectId: "project-a",
        plan,
        committedAt: new Date("2026-06-02T00:00:00.000Z"),
      })

      await expect(applyAgain()).rejects.toThrow(ObjectStorageError)
      await expect(applyAgain()).rejects.toThrow(
        "[Sixb] Edit commit cannot create existing object 'Invoice:inv_dup'."
      )
    } finally {
      closeSqliteStorage(storage)
    }
  })

  test("rejects a create whose link already exists with a typed, identified error", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-edit-conflict-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    try {
      // Seed only the endpoints (no link) so the plan nets to a link `create`.
      await storage.objects.applyObjectUpserted(
        objectEvent("Customer", "cus_1", { id: "cus_1", name: "Acme" })
      )
      await storage.objects.applyObjectUpserted(
        objectEvent("Invoice", "inv_1", { id: "inv_1", status: "draft" })
      )

      const plan = await planEditBatch({
        projectId: "project-a",
        ontology,
        storage: { objects: storage.objects },
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
        storage.objects.applyEditCommitPlan({
          projectId: "project-a",
          plan,
          committedAt: new Date("2026-06-03T00:00:00.000Z"),
        })

      await storage.objects.applyEditCommitPlan({
        projectId: "project-a",
        plan,
        committedAt: new Date("2026-06-02T00:00:00.000Z"),
      })

      await expect(applyAgain()).rejects.toThrow(ObjectStorageError)
      await expect(applyAgain()).rejects.toThrow(
        "[Sixb] Edit commit cannot create existing link 'Invoice:inv_1:customer:Customer:cus_1'."
      )
    } finally {
      closeSqliteStorage(storage)
    }
  })
})

describe("SQLite edit commit concurrency", () => {
  // SQLite serializes transactions on its single connection, so the PG e2e's barrier (which waits
  // for both commits to reach `applyEditCommitPlan`) would deadlock here. That serialization is the
  // guarantee under test: two commits racing on a cardinality-one link resolve to one winner.
  test("serializes concurrent commits racing on a cardinality-one link", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-edit-concurrency-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    try {
      // Seed the endpoints with no customer link so each commit nets to a fresh link `create`.
      await storage.objects.applyObjectUpserted(
        objectEvent("Customer", "cus_1", { id: "cus_1", name: "Acme" })
      )
      await storage.objects.applyObjectUpserted(
        objectEvent("Customer", "cus_2", { id: "cus_2", name: "Globex" })
      )
      await storage.objects.applyObjectUpserted(
        objectEvent("Invoice", "inv_1", { id: "inv_1", status: "draft" })
      )
      await queueRunningRun(storage, "run_link_cus_1")
      await queueRunningRun(storage, "run_link_cus_2")

      const subject = { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" } as const
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
          storage,
          projectId: "project-a",
          runId: "run_link_cus_1",
          actionId: "linkCustomer",
          subject,
          ontology,
          batch: batchA,
        }),
        commitActionEditBatch({
          storage,
          projectId: "project-a",
          runId: "run_link_cus_2",
          actionId: "linkCustomer",
          subject,
          ontology,
          batch: batchB,
        }),
      ])

      const fulfilled = results.filter((result) => result.status === "fulfilled")
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      )
      const links = await storage.objects.listLinks({
        projectId: "project-a",
        objectTypeId: "Invoice",
        objectId: "inv_1",
        linkId: "customer",
      })

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.reason).toBeInstanceOf(Error)
      expect((rejected[0]?.reason as Error).message).toContain("cardinality 'one'")
      expect(links).toHaveLength(1)
      expect(["cus_1", "cus_2"]).toContain(links[0]?.targetId)
    } finally {
      closeSqliteStorage(storage)
    }
  })
})

async function queueRunningRun(storage: SqliteStorage, runId: string): Promise<void> {
  await storage.actionRuns.queue({
    id: runId,
    projectId: "project-a",
    actionId: "linkCustomer",
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
    params: {},
    idempotencyKey: `action:project-a:${runId}`,
  })
  await storage.actionRuns.start({ id: runId, projectId: "project-a" })
}

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

async function seedGraph(storage: SqliteStorage): Promise<void> {
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

function closeSqliteStorage(storage: SqliteStorage): void {
  storage.objects.close()
  storage.auth.close()
  storage.actionRuns.close()
  storage.pipelineRuns.close()
  storage.projectionRuns.close()
  storage.workflowRuns.close()
  storage.workflowInterventions.close()
  storage.syncRuns.close()
  storage.timeseries.close()
  storage.webhookDeliveries.close()
  storage.webhookRuns.close()
  storage.rules.close()
}
