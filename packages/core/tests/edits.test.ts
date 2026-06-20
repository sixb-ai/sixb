import { describe, expect, test } from "bun:test"
import {
  type ActionRunStorage,
  commitActionEditBatch,
  defineObjectType,
  defineValueType,
  deriveEditCommitDiff,
  type EditBatch,
  type EditObjectRef,
  InMemoryStorage,
  link,
  type ObjectLink,
  ObjectStorageError,
  type ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  planEditBatch,
  prop,
  type RecordEditsOptions,
  recordEdits,
  type Storage,
  StorageTransactionError,
  type StorageTransactionOptions,
  validateEditBatch,
  valueTypeRef,
} from "../src"

const Customer = defineObjectType({
  id: "Customer",
  name: "Customer",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
    prop("status", "string"),
  ],
})

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double", { required: true }),
    prop("status", "string", { required: true }),
    prop("paidAt", "timestamp"),
    prop("temperature", "double", { mode: "telemetry" }),
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
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { required: true }),
  ],
  links: [link("invoice", Invoice, { cardinality: "one" })],
})

const MoneyAmount = defineValueType({
  id: "MoneyAmount",
  name: "Money Amount",
  schema: {
    type: "object",
    properties: {
      value: { schema: "double", required: true },
      currency: { schema: "string", required: true },
    },
  },
})

const InvoiceWithResolvedAmount = defineObjectType({
  id: "InvoiceWithResolvedAmount",
  name: "Invoice With Resolved Amount",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("total", valueTypeRef(MoneyAmount), { required: true }),
  ],
})

const InvoiceWithRegisteredAmount = defineObjectType({
  id: "InvoiceWithRegisteredAmount",
  name: "Invoice With Registered Amount",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("total", valueTypeRef("MoneyAmount"), { required: true }),
  ],
})

const ontology = new OntologyRegistry({ sources: [Customer, Invoice, Payment] })

type RuntimeEditHandle = EditObjectRef & {
  update(properties: Record<string, unknown>): void
  delete(): void
  link(
    link: { objectTypeId: string; id: string; link: ObjectLink },
    target: EditObjectRef,
    options?: { properties?: Record<string, unknown> }
  ): void
  unlink(link: { objectTypeId: string; id: string; link: ObjectLink }, target: EditObjectRef): void
}

type RuntimeRecordObjects = (objectType: ObjectTypeWithPropertyTokens) => {
  byId(primaryId: string): RuntimeEditHandle
  create(properties: Record<string, unknown>): RuntimeEditHandle
}

function recordRuntimeEdits(
  options: RecordEditsOptions,
  handler: (ctx: { objects: RuntimeRecordObjects }) => void
): EditBatch {
  return (
    recordEdits as (options: RecordEditsOptions, handler: (ctx: unknown) => void) => EditBatch
  )(options, handler as (ctx: unknown) => void)
}

describe("EditBatch core contract", () => {
  test("records object API mutations into one serializable batch", async () => {
    const storage = await createSeededStorage()
    let createdInvoiceId = ""
    const batch = recordRuntimeEdits({ runId: "act_1" }, ({ objects }) => {
      const createdInvoice = objects(Invoice).create({
        amount: 250,
        status: "draft",
      })
      const customer = objects(Customer).byId("cus_1")
      createdInvoiceId = createdInvoice.primaryId

      expect(JSON.parse(JSON.stringify(createdInvoice))).toEqual({
        objectTypeId: "Invoice",
        primaryId: createdInvoice.primaryId,
      })

      createdInvoice.update({ status: "sent" })
      createdInvoice.link(Invoice.l.customer, customer, {
        properties: { role: "billTo" },
      })
    })

    const result = await validateEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch,
    })

    expect(result.batch.operations).toEqual([
      {
        kind: "object.create",
        objectTypeId: "Invoice",
        primaryId: createdInvoiceId,
        properties: {
          id: createdInvoiceId,
          amount: 250,
          status: "draft",
        },
      },
      {
        kind: "object.update",
        objectTypeId: "Invoice",
        primaryId: createdInvoiceId,
        properties: {
          status: "sent",
        },
      },
      {
        kind: "link.create",
        source: { objectTypeId: "Invoice", primaryId: createdInvoiceId },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
        properties: { role: "billTo" },
      },
    ])
    expect(result.diff).toEqual({
      objects: [
        {
          objectTypeId: "Invoice",
          primaryId: createdInvoiceId,
          operation: "create",
          changedProperties: ["amount", "id", "status"],
        },
      ],
      links: [
        {
          operation: "create",
          source: { objectTypeId: "Invoice", primaryId: createdInvoiceId },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
      ],
    })
  })

  test("derives update and link property update diffs from current storage state", async () => {
    const storage = await createSeededStorage()

    await storage.objects.applyLinkUpserted({
      id: "evt_link_1",
      schemaVersion: 1,
      projectId: "project-a",
      type: "link.upserted",
      topic: "links",
      partitionKey: "Invoice:inv_1:customer",
      occurredAt: "2026-06-01T00:00:00.000Z",
      cursor: "evt_link_1",
      payload: {
        sourceTypeId: "Invoice",
        sourceId: "inv_1",
        linkId: "customer",
        targetTypeId: "Customer",
        targetId: "cus_1",
        properties: { role: "old" },
      },
    })

    const batch: EditBatch = {
      version: 1,
      operations: [
        {
          kind: "object.update",
          objectTypeId: "Invoice",
          primaryId: "inv_1",
          properties: {
            status: "paid",
            paidAt: new Date("2026-06-02T10:00:00.000Z").toISOString(),
          },
        },
        {
          kind: "link.create",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
          properties: { role: "billTo" },
        },
      ],
    }

    const diff = await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch,
    })

    expect(diff).toEqual({
      objects: [
        {
          objectTypeId: "Invoice",
          primaryId: "inv_1",
          operation: "update",
          changedProperties: ["paidAt", "status"],
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

  test("deriving a diff does not mutate the in-memory object store", async () => {
    const storage = await createSeededStorage()

    await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch: recordRuntimeEdits({ runId: "act_readonly" }, ({ objects }) => {
        objects(Invoice).byId("inv_1").update({
          status: "paid",
        })
      }),
    })

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })

    expect(row?.properties.status).toBe("draft")
  })

  test("normalizes recorded edits with resolved and registered value type refs", async () => {
    let resolvedInvoiceId = ""
    const resolvedBatch = recordRuntimeEdits(
      { runId: "act_value_type_resolved" },
      ({ objects }) => {
        const resolvedInvoice = objects(InvoiceWithResolvedAmount).create({
          total: { value: 120, currency: "EUR" },
        })
        resolvedInvoiceId = resolvedInvoice.primaryId
      }
    )

    expect(resolvedBatch.operations[0]).toEqual({
      kind: "object.create",
      objectTypeId: "InvoiceWithResolvedAmount",
      primaryId: resolvedInvoiceId,
      properties: {
        id: resolvedInvoiceId,
        total: { value: 120, currency: "EUR" },
      },
    })

    let registeredInvoiceId = ""
    const registeredBatch = recordRuntimeEdits(
      {
        runId: "act_value_type_registered",
        valueTypesById: new Map([[MoneyAmount.id, MoneyAmount]]),
      },
      ({ objects }) => {
        const registeredInvoice = objects(InvoiceWithRegisteredAmount).create({
          total: { value: 240, currency: "USD" },
        })
        registeredInvoiceId = registeredInvoice.primaryId
      }
    )

    expect(registeredBatch.operations[0]).toEqual({
      kind: "object.create",
      objectTypeId: "InvoiceWithRegisteredAmount",
      primaryId: registeredInvoiceId,
      properties: {
        id: registeredInvoiceId,
        total: { value: 240, currency: "USD" },
      },
    })
  })

  test("rejects invalid local mutations before commit", async () => {
    const storage = await createSeededStorage()

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: recordRuntimeEdits({ runId: "act_3" }, ({ objects }) => {
          objects(Invoice).byId("missing").update({ status: "paid" })
        }),
      })
    ).rejects.toThrow("references missing object 'Invoice:missing'")

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: {
          version: 1,
          operations: [
            {
              kind: "object.update",
              objectTypeId: "Invoice",
              primaryId: "inv_1",
              properties: { id: "other" },
            },
          ],
        },
      })
    ).rejects.toThrow("cannot update primary property")

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: {
          version: 1,
          operations: [
            {
              kind: "object.update",
              objectTypeId: "Invoice",
              primaryId: "inv_1",
              properties: { temperature: 21 },
            },
          ],
        },
      })
    ).rejects.toThrow("cannot edit telemetry property")
  })

  test("enforces refs, required link properties, and cardinality", async () => {
    const storage = await createSeededStorage()
    await storage.objects.applyObjectUpserted({
      id: "evt_customer_2",
      schemaVersion: 1,
      projectId: "project-a",
      type: "object.upserted",
      topic: "objects",
      partitionKey: "Customer:cus_2",
      occurredAt: "2026-06-01T00:00:00.000Z",
      cursor: "evt_customer_2",
      payload: {
        objectTypeId: "Customer",
        primaryId: "cus_2",
        properties: {
          id: "cus_2",
          name: "Second Customer",
        },
      },
    })
    await storage.objects.applyLinkUpserted({
      id: "evt_link_2",
      schemaVersion: 1,
      projectId: "project-a",
      type: "link.upserted",
      topic: "links",
      partitionKey: "Invoice:inv_1:customer",
      occurredAt: "2026-06-01T00:00:00.000Z",
      cursor: "evt_link_2",
      payload: {
        sourceTypeId: "Invoice",
        sourceId: "inv_1",
        linkId: "customer",
        targetTypeId: "Customer",
        targetId: "cus_1",
        properties: { role: "billTo" },
      },
    })

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: recordRuntimeEdits({ runId: "act_4" }, ({ objects }) => {
          objects(Invoice)
            .byId("inv_1")
            .link(Invoice.l.customer, objects(Customer).byId("cus_2"), {
              properties: { role: "shipTo" },
            })
        }),
      })
    ).rejects.toThrow("cardinality 'one'")

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: [
          {
            kind: "link.delete",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
          },
          {
            kind: "link.create",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_2" },
          },
        ],
      })
    ).rejects.toThrow("Missing required link property 'role'")
  })

  test("supports object delete as contract-only diff", async () => {
    const storage = await createSeededStorage()

    const diff = await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch: recordRuntimeEdits({ runId: "act_6" }, ({ objects }) => {
        objects(Payment).byId("pay_1").delete()
      }),
    })

    expect(diff).toEqual({
      objects: [
        {
          objectTypeId: "Payment",
          primaryId: "pay_1",
          operation: "delete",
          changedProperties: [],
        },
      ],
      links: [],
    })
  })

  test("cascades object delete diffs to incoming and outgoing links", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)
    await seedPaymentInvoiceLink(storage)

    const diff = await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch: recordRuntimeEdits({ runId: "act_delete" }, ({ objects }) => {
        objects(Invoice).byId("inv_1").delete()
      }),
    })

    expect(diff).toEqual({
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

  test("cancels create and link diffs when a created object is deleted", async () => {
    const storage = await createSeededStorage()
    const batch = recordRuntimeEdits({ runId: "act_create_delete" }, ({ objects }) => {
      const invoice = objects(Invoice).create({
        id: "inv_created",
        amount: 300,
        status: "draft",
      })
      invoice.link(Invoice.l.customer, objects(Customer).byId("cus_1"), {
        properties: { role: "billTo" },
      })
      invoice.delete()
    })

    const diff = await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch,
    })

    expect(diff).toEqual({ objects: [], links: [] })
  })

  test("commits edits atomically in in-memory storage and reuses the commit on retry", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)

    await storage.actionRuns.queue({
      id: "run_commit_1",
      projectId: "project-a",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_commit_1",
    })
    await storage.actionRuns.start({
      id: "run_commit_1",
      projectId: "project-a",
    })

    const batch = recordRuntimeEdits({ runId: "run_commit_1" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })
    const result = await commitActionEditBatch({
      storage,
      projectId: "project-a",
      runId: "run_commit_1",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch,
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })
    const retry = await commitActionEditBatch({
      storage,
      projectId: "project-a",
      runId: "run_commit_1",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch,
      committedAt: new Date("2026-06-03T00:00:00.000Z"),
    })

    const invoice = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    const run = await storage.actionRuns.getById({
      projectId: "project-a",
      id: "run_commit_1",
    })

    expect(result.commit.created).toBe(true)
    expect(retry.commit.created).toBe(false)
    expect(retry.commit.diff).toEqual(result.commit.diff)
    expect(invoice?.properties.status).toBe("paid")
    expect(invoice?.version).toBe(2)
    expect(run?.commit?.diff).toEqual(result.commit.diff)
  })

  test("rolls back in-memory object changes when commit recording fails", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)

    await storage.actionRuns.queue({
      id: "run_rollback",
      projectId: "project-a",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_rollback",
    })
    await storage.actionRuns.start({
      id: "run_rollback",
      projectId: "project-a",
    })

    const failingStorage = withFailingRecordCommit(storage)
    const batch = recordRuntimeEdits({ runId: "run_rollback" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })

    await expect(
      commitActionEditBatch({
        storage: failingStorage,
        projectId: "project-a",
        runId: "run_rollback",
        actionId: "markPaid",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch,
        committedAt: new Date("2026-06-02T00:00:00.000Z"),
      })
    ).rejects.toThrow("commit trail write failed")

    const invoice = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    const run = await storage.actionRuns.getById({
      projectId: "project-a",
      id: "run_rollback",
    })

    expect(invoice?.properties.status).toBe("draft")
    expect(invoice?.version).toBe(1)
    expect(run?.commit).toBeUndefined()
  })

  test("retries serializable edit commit conflicts", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)

    await storage.actionRuns.queue({
      id: "run_serializable_retry",
      projectId: "project-a",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_serializable_retry",
    })
    await storage.actionRuns.start({
      id: "run_serializable_retry",
      projectId: "project-a",
    })

    let attempts = 0
    const retryingStorage: Storage = {
      ...storage,
      transaction: async (run, options?: StorageTransactionOptions) => {
        attempts++
        expect(options).toEqual({ isolation: "serializable" })
        if (attempts === 1) {
          throw new StorageTransactionError("serialization conflict", {
            code: "serialization_failure",
          })
        }
        return storage.transaction(run, options)
      },
    }
    const batch = recordRuntimeEdits({ runId: "run_serializable_retry" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })

    const result = await commitActionEditBatch({
      storage: retryingStorage,
      projectId: "project-a",
      runId: "run_serializable_retry",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch,
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })

    const invoice = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })

    expect(attempts).toBe(2)
    expect(result.commit.created).toBe(true)
    expect(result.commit.committedAt).toEqual(new Date("2026-06-02T00:00:00.000Z"))
    expect(invoice?.properties.status).toBe("paid")
  })

  test("rejects edit commits for a different action run identity", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)

    await storage.actionRuns.queue({
      id: "run_identity",
      projectId: "project-a",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_identity",
    })
    await storage.actionRuns.start({
      id: "run_identity",
      projectId: "project-a",
    })

    const batch = recordRuntimeEdits({ runId: "run_identity" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })

    await expect(
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_identity",
        actionId: "voidInvoice",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        ontology,
        batch,
      })
    ).rejects.toThrow("belongs to action 'markPaid'")

    await expect(
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_identity",
        actionId: "markPaid",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_2" },
        ontology,
        batch,
      })
    ).rejects.toThrow("different subject")

    await expect(
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_identity",
        actionId: "markPaid",
        subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
        idempotencyKey: "different",
        ontology,
        batch,
      })
    ).rejects.toThrow("different idempotency key")
  })
})

describe("EditBatch net diff (delete then re-create within one batch)", () => {
  test("re-creating a deleted existing link nets to an update of the live row", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage) // inv_1 -> cus_1 { role: "billTo" }

    const batch: EditBatch = {
      version: 1,
      operations: [
        {
          kind: "link.delete",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
        {
          kind: "link.create",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
          properties: { role: "shipTo" },
        },
      ],
    }

    const plan = await planEditBatch({ projectId: "project-a", ontology, storage, batch })

    // The row still physically exists, so the delete+create must collapse to a single update,
    // never a `create` of a live row (which would fail at apply time).
    expect(plan.diff.links).toEqual([
      {
        operation: "update",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
      },
    ])
    expect(plan.links.deletes).toEqual([])
    expect(plan.links.upserts).toEqual([
      {
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
        properties: { role: "shipTo" },
        operation: "update",
      },
    ])
  })

  test("re-creating a deleted link replaces (does not merge) the prior properties", async () => {
    const storage = await createSeededStorage()
    await storage.objects.applyLinkUpserted({
      id: "evt_link_props",
      schemaVersion: 1,
      projectId: "project-a",
      type: "link.upserted",
      topic: "links",
      partitionKey: "Invoice:inv_1:customer",
      occurredAt: "2026-06-01T00:00:00.000Z",
      cursor: "evt_link_props",
      payload: {
        sourceTypeId: "Invoice",
        sourceId: "inv_1",
        linkId: "customer",
        targetTypeId: "Customer",
        targetId: "cus_1",
        properties: { role: "old" },
      },
    })

    const batch: EditBatch = {
      version: 1,
      operations: [
        {
          kind: "link.delete",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
        {
          kind: "link.create",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
          properties: { role: "new" },
        },
      ],
    }

    const plan = await planEditBatch({ projectId: "project-a", ontology, storage, batch })

    expect(plan.links.upserts).toEqual([
      {
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
        properties: { role: "new" },
        operation: "update",
      },
    ])
  })

  test("re-creating a deleted link with identical properties is a no-op", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage) // inv_1 -> cus_1 { role: "billTo" }

    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: {
        version: 1,
        operations: [
          {
            kind: "link.delete",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
          },
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

    expect(plan.diff.links).toEqual([])
    expect(plan.links.upserts).toEqual([])
    expect(plan.links.deletes).toEqual([])
  })

  test("swapping a cardinality-one target via delete then create is allowed", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage) // inv_1 -> cus_1
    await storage.objects.applyObjectUpserted({
      id: "evt_customer_2",
      schemaVersion: 1,
      projectId: "project-a",
      type: "object.upserted",
      topic: "objects",
      partitionKey: "Customer:cus_2",
      occurredAt: "2026-06-01T00:00:00.000Z",
      cursor: "evt_customer_2",
      payload: {
        objectTypeId: "Customer",
        primaryId: "cus_2",
        properties: { id: "cus_2", name: "Second Customer" },
      },
    })

    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: {
        version: 1,
        operations: [
          {
            kind: "link.delete",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
          },
          {
            kind: "link.create",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_2" },
            properties: { role: "shipTo" },
          },
        ],
      },
    })

    expect(plan.diff.links).toEqual([
      {
        operation: "delete",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
      },
      {
        operation: "create",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_2" },
      },
    ])
    expect(plan.links.deletes).toEqual([
      {
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
      },
    ])
  })

  test("re-creating a deleted existing object nets to an update with the full new properties", async () => {
    const storage = await createSeededStorage() // inv_1 = { amount: 120, status: "draft" }

    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: {
        version: 1,
        operations: [
          { kind: "object.delete", objectTypeId: "Invoice", primaryId: "inv_1" },
          {
            kind: "object.create",
            objectTypeId: "Invoice",
            primaryId: "inv_1",
            properties: { id: "inv_1", amount: 999, status: "reissued" },
          },
        ],
      },
    })

    expect(plan.diff.objects).toEqual([
      {
        objectTypeId: "Invoice",
        primaryId: "inv_1",
        operation: "update",
        changedProperties: ["amount", "status"],
      },
    ])
    expect(plan.objects.deletes).toEqual([])
    expect(plan.objects.upserts).toEqual([
      {
        objectTypeId: "Invoice",
        primaryId: "inv_1",
        properties: { id: "inv_1", amount: 999, status: "reissued" },
        operation: "update",
      },
    ])
  })

  test("commits a delete-then-create of an existing link as an in-place update", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage) // inv_1 -> cus_1 { role: "billTo" }

    await storage.actionRuns.queue({
      id: "run_relink",
      projectId: "project-a",
      actionId: "relink",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      params: {},
      idempotencyKey: "action:project-a:run_relink",
    })
    await storage.actionRuns.start({ id: "run_relink", projectId: "project-a" })

    const result = await commitActionEditBatch({
      storage,
      projectId: "project-a",
      runId: "run_relink",
      actionId: "relink",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch: {
        version: 1,
        operations: [
          {
            kind: "link.delete",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
          },
          {
            kind: "link.create",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
            properties: { role: "shipTo" },
          },
        ],
      },
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })

    expect(result.commit.created).toBe(true)
    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Invoice",
      objectId: "inv_1",
      linkId: "customer",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.properties).toEqual({ role: "shipTo" })
  })
})

describe("EditCommitPlan apply conflicts (concurrent divergence from the plan)", () => {
  test("rejects a create whose object already exists with a typed, identified error", async () => {
    const storage = await createSeededStorage()
    // The net-diff planner never emits a `create` for a live row, so build the plan while the row is
    // absent; the first apply creates it and the second reproduces the concurrent-create hazard the
    // serializable+retry machinery is meant to surface uniformly across providers.
    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: {
        version: 1,
        operations: [
          {
            kind: "object.create",
            objectTypeId: "Invoice",
            primaryId: "inv_dup",
            properties: { id: "inv_dup", amount: 10, status: "draft" },
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
  })

  test("rejects a create whose link already exists with a typed, identified error", async () => {
    const storage = await createSeededStorage()
    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
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
  })
})

function withFailingRecordCommit(storage: InMemoryStorage): Storage {
  return {
    ...storage,
    transaction: (run, options) =>
      storage.transaction((tx) => {
        const actionRuns = requireActionRuns(tx.actionRuns)
        const failingActionRuns: ActionRunStorage = {
          queue: (input) => actionRuns.queue(input),
          start: (input) => actionRuns.start(input),
          enterPhase: (input) => actionRuns.enterPhase(input),
          recordWriteback: (input) => actionRuns.recordWriteback(input),
          recordCommit: async () => {
            throw new Error("commit trail write failed")
          },
          recordEffects: (input) => actionRuns.recordEffects(input),
          finish: (input) => actionRuns.finish(input),
          getById: (input) => actionRuns.getById(input),
          list: (input) => actionRuns.list(input),
        }

        return run({
          ...tx,
          actionRuns: failingActionRuns,
          transaction: tx.transaction,
        })
      }, options),
  }
}

function requireActionRuns(actionRuns: ActionRunStorage | undefined): ActionRunStorage {
  if (!actionRuns) {
    throw new Error("Missing action run storage")
  }

  return actionRuns
}

async function createSeededStorage(): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage()
  const timestamp = new Date("2026-06-01T00:00:00.000Z")

  await storage.objects.applyObjectUpserted({
    id: "evt_customer_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Customer:cus_1",
    occurredAt: timestamp.toISOString(),
    cursor: "evt_customer_1",
    payload: {
      objectTypeId: "Customer",
      primaryId: "cus_1",
      properties: {
        id: "cus_1",
        name: "Acme",
      },
    },
  })
  await storage.objects.applyObjectUpserted({
    id: "evt_invoice_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Invoice:inv_1",
    occurredAt: timestamp.toISOString(),
    cursor: "evt_invoice_1",
    payload: {
      objectTypeId: "Invoice",
      primaryId: "inv_1",
      properties: {
        id: "inv_1",
        amount: 120,
        status: "draft",
      },
    },
  })
  await storage.objects.applyObjectUpserted({
    id: "evt_payment_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.upserted",
    topic: "objects",
    partitionKey: "Payment:pay_1",
    occurredAt: timestamp.toISOString(),
    cursor: "evt_payment_1",
    payload: {
      objectTypeId: "Payment",
      primaryId: "pay_1",
      properties: {
        id: "pay_1",
        status: "pending",
      },
    },
  })

  return storage
}

async function seedInvoiceCustomerLink(storage: InMemoryStorage): Promise<void> {
  await storage.objects.applyLinkUpserted({
    id: "evt_invoice_customer",
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.upserted",
    topic: "links",
    partitionKey: "Invoice:inv_1:customer",
    occurredAt: "2026-06-01T00:00:00.000Z",
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
}

async function seedPaymentInvoiceLink(storage: InMemoryStorage): Promise<void> {
  await storage.objects.applyLinkUpserted({
    id: "evt_payment_invoice",
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.upserted",
    topic: "links",
    partitionKey: "Payment:pay_1:invoice",
    occurredAt: "2026-06-01T00:00:00.000Z",
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
