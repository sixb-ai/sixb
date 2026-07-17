import { describe, expect, test } from "bun:test"
import {
  defineObjectType,
  defineValueType,
  InMemoryStorage,
  link,
  type ObjectLink,
  type ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  prop,
  type Storage,
  type StorageTransactionOptions,
  valueTypeRef,
} from "../src"
import { commitActionEditBatch, type SerializationRetryOptions } from "../src/actions"
import { type RecordEditsOptions, recordEdits } from "../src/actions/worker"
import {
  deriveEditCommitDiff,
  type EditBatch,
  type EditObjectRef,
  planEditBatch,
  validateEditBatch,
} from "../src/edits"
import { type ActionRunStorage, ObjectStorageError, StorageTransactionError } from "../src/storage"

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
    prop("category", "string", { nullable: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [
    link("customer", Customer, {
      cardinality: "one",
      properties: [prop("role", "string", { required: true }), prop("since", "timestamp")],
    }),
    link("reviewers", Customer, { cardinality: "many" }),
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

/** Removes wall-clock delay from serialization-failure retries so retry tests stay deterministic. */
const noopSleep = (): Promise<void> => Promise.resolve()

type RuntimeEditHandle = EditObjectRef & {
  update(properties: Record<string, unknown>): void
  delete(): void
  link(
    link: { objectTypeId: string; id: string; link: ObjectLink },
    target: EditObjectRef,
    options?: { properties?: Record<string, unknown> }
  ): void
  unlink(link: { objectTypeId: string; id: string; link: ObjectLink }, target: EditObjectRef): void
  setLink(
    link: { objectTypeId: string; id: string; link: ObjectLink },
    target: EditObjectRef,
    options?: { properties?: Record<string, unknown> }
  ): void
  clearLink(link: { objectTypeId: string; id: string; link: ObjectLink }): void
}

type RuntimeRecordObjects = (objectType: ObjectTypeWithPropertyTokens) => {
  byId(primaryId: string): RuntimeEditHandle
  upsert(properties: Record<string, unknown>): RuntimeEditHandle
  create(properties: Record<string, unknown>): RuntimeEditHandle
}

function recordRuntimeEdits(
  options: RecordEditsOptions,
  handler: (ctx: { objects: RuntimeRecordObjects }) => void
): Promise<EditBatch> {
  return (
    recordEdits as (
      options: RecordEditsOptions,
      handler: (ctx: unknown) => void
    ) => Promise<EditBatch>
  )(options, handler as (ctx: unknown) => void)
}

describe("EditBatch core contract", () => {
  test("records object API mutations into one serializable batch", async () => {
    const storage = await createSeededStorage()
    let createdInvoiceId = ""
    const batch = await recordRuntimeEdits({ runId: "act_1" }, ({ objects }) => {
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

    await storage.objects.applyLinkUpsert({
      id: "evt_link_1",
      schemaVersion: 1,
      projectId: "project-a",
      type: "link.created",
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
        propertyChanges: {},
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
      batch: await recordRuntimeEdits({ runId: "act_readonly" }, ({ objects }) => {
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
    const resolvedBatch = await recordRuntimeEdits(
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
    const registeredBatch = await recordRuntimeEdits(
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
        batch: await recordRuntimeEdits({ runId: "act_3" }, ({ objects }) => {
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
    await storage.objects.applyObjectUpsert({
      id: "evt_customer_2",
      schemaVersion: 1,
      projectId: "project-a",
      type: "object.created",
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
        propertyChanges: {},
      },
    })
    await storage.objects.applyLinkUpsert({
      id: "evt_link_2",
      schemaVersion: 1,
      projectId: "project-a",
      type: "link.created",
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
        propertyChanges: {},
      },
    })

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: await recordRuntimeEdits({ runId: "act_4" }, ({ objects }) => {
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

    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_6" }, ({ objects }) => {
        objects(Payment).byId("pay_1").delete()
      }),
    })

    expect(plan.diff).toEqual({
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
    expect(plan.objects.deletes).toEqual([
      {
        objectTypeId: "Payment",
        primaryId: "pay_1",
        previousProperties: { id: "pay_1", status: "pending" },
      },
    ])
  })

  test("cascades object delete diffs to incoming and outgoing links", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)
    await seedPaymentInvoiceLink(storage)

    const diff = await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_delete" }, ({ objects }) => {
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
    const batch = await recordRuntimeEdits({ runId: "act_create_delete" }, ({ objects }) => {
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

    const batch = await recordRuntimeEdits({ runId: "run_commit_1" }, ({ objects }) => {
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
    expect(result.commit.events.map((event) => event.type)).toEqual(["object.updated"])
    expect(result.commit.events[0]).toMatchObject({
      type: "object.updated",
      payload: {
        objectTypeId: "Invoice",
        primaryId: "inv_1",
        propertyChanges: {
          status: { operation: "updated", before: "draft", after: "paid" },
        },
      },
    })
    expect(retry.commit.created).toBe(false)
    expect(retry.commit.events).toEqual([])
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
    const batch = await recordRuntimeEdits({ runId: "run_rollback" }, ({ objects }) => {
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
    const batch = await recordRuntimeEdits({ runId: "run_serializable_retry" }, ({ objects }) => {
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
      serializationRetry: { sleep: noopSleep },
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

    const batch = await recordRuntimeEdits({ runId: "run_identity" }, ({ objects }) => {
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

describe("EditBatch staged object upsert", () => {
  test("records create-or-merge intent and returns an editable handle", async () => {
    const storage = await createSeededStorage()
    const batch = await recordRuntimeEdits({ runId: "act_upsert" }, ({ objects }) => {
      objects(Invoice).upsert({
        id: "inv_1",
        status: "paid",
        category: null,
      })
      objects(Payment).upsert({ id: "pay_2", status: "pending" }).update({ status: "settled" })
    })

    expect(batch.operations).toEqual([
      {
        kind: "object.upsert",
        objectTypeId: "Invoice",
        primaryId: "inv_1",
        properties: { id: "inv_1", status: "paid", category: null },
      },
      {
        kind: "object.upsert",
        objectTypeId: "Payment",
        primaryId: "pay_2",
        properties: { id: "pay_2", status: "pending" },
      },
      {
        kind: "object.update",
        objectTypeId: "Payment",
        primaryId: "pay_2",
        properties: { status: "settled" },
      },
    ])

    const plan = await planEditBatch({ projectId: "project-a", ontology, storage, batch })
    expect(plan.diff.objects).toEqual([
      {
        objectTypeId: "Invoice",
        primaryId: "inv_1",
        operation: "update",
        changedProperties: ["category", "status"],
      },
      {
        objectTypeId: "Payment",
        primaryId: "pay_2",
        operation: "create",
        changedProperties: ["id", "status"],
      },
    ])
    expect(plan.objects.upserts).toEqual([
      {
        objectTypeId: "Invoice",
        primaryId: "inv_1",
        properties: { id: "inv_1", amount: 120, status: "paid", category: null },
        previousProperties: { id: "inv_1", amount: 120, status: "draft" },
        operation: "update",
      },
      {
        objectTypeId: "Payment",
        primaryId: "pay_2",
        properties: { id: "pay_2", status: "settled" },
        operation: "create",
      },
    ])
  })

  test("checks identity and create requirements only when the object is absent", async () => {
    const storage = await createSeededStorage()

    await expect(
      recordRuntimeEdits({ runId: "act_missing_upsert_id" }, ({ objects }) => {
        objects(Invoice).upsert({ status: "draft" })
      })
    ).rejects.toThrow("primary property 'id' must be a non-empty string")

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: {
          kind: "object.upsert",
          objectTypeId: "Invoice",
          primaryId: "inv_1",
          properties: { id: "inv_other", status: "paid" },
        },
      })
    ).rejects.toThrow("upsert 'Invoice:inv_1' must include matching primary property 'id'")

    const existingPlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_partial_upsert" }, ({ objects }) => {
        objects(Invoice).upsert({ id: "inv_1", status: "paid" })
      }),
    })
    expect(existingPlan.objects.upserts[0]?.properties).toEqual({
      id: "inv_1",
      amount: 120,
      status: "paid",
    })

    await expect(
      planEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: await recordRuntimeEdits({ runId: "act_incomplete_upsert" }, ({ objects }) => {
          objects(Invoice).upsert({ id: "inv_missing", status: "draft" })
        }),
      })
    ).rejects.toThrow("Missing required property 'amount' for object type 'Invoice'")
  })

  test("uses ordered working state and does not resurrect deleted properties", async () => {
    const storage = await createSeededStorage()
    const createdPlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_ordered_upsert" }, ({ objects }) => {
        objects(Invoice).upsert({ id: "inv_2", amount: 20, status: "draft" })
        objects(Invoice).upsert({ id: "inv_2", status: "sent" })
      }),
    })
    expect(createdPlan.objects.upserts[0]?.properties).toEqual({
      id: "inv_2",
      amount: 20,
      status: "sent",
    })

    await expect(
      planEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: await recordRuntimeEdits({ runId: "act_delete_upsert" }, ({ objects }) => {
          objects(Invoice).byId("inv_1").delete()
          objects(Invoice).upsert({ id: "inv_1", status: "recreated" })
        }),
      })
    ).rejects.toThrow("Missing required property 'amount' for object type 'Invoice'")
  })

  test("collapses unchanged upserts and emits events for committed net changes", async () => {
    const storage = await createSeededStorage()
    const noOp = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_noop_upsert" }, ({ objects }) => {
        objects(Invoice).upsert({ id: "inv_1", status: "draft" })
      }),
    })
    expect(noOp.diff).toEqual({ objects: [], links: [] })

    await queueRunningRun(storage, "run_upsert_events", "syncObjects")
    const result = await commitActionEditBatch({
      storage,
      projectId: "project-a",
      runId: "run_upsert_events",
      actionId: "syncObjects",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch: await recordRuntimeEdits({ runId: "run_upsert_events" }, ({ objects }) => {
        objects(Invoice).upsert({ id: "inv_1", status: "paid" })
        objects(Payment).upsert({ id: "pay_2", status: "pending" })
      }),
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })

    expect(result.commit.events.map((event) => event.type)).toEqual([
      "object.updated",
      "object.created",
    ])
    expect(result.commit.events).toEqual([
      expect.objectContaining({
        type: "object.updated",
        payload: expect.objectContaining({ objectTypeId: "Invoice", primaryId: "inv_1" }),
      }),
      expect.objectContaining({
        type: "object.created",
        payload: expect.objectContaining({ objectTypeId: "Payment", primaryId: "pay_2" }),
      }),
    ])
  })
})

describe("EditBatch cardinality-one link assignment", () => {
  test("records set and clear intent without reading the current target", async () => {
    const batch = await recordRuntimeEdits({ runId: "act_assign_link" }, ({ objects }) => {
      const invoice = objects(Invoice).byId("inv_1")
      invoice.setLink(Invoice.l.customer, objects(Customer).byId("cus_1"), {
        properties: { role: "billTo" },
      })
      invoice.clearLink(Invoice.l.customer)
    })

    expect(batch.operations).toEqual([
      {
        kind: "link.set",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
        properties: { role: "billTo" },
      },
      {
        kind: "link.clear",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
      },
    ])

    const plan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage: await createSeededStorage(),
      batch,
    })
    expect(plan.diff.links).toEqual([])
  })

  test("creates, updates, and preserves a same-target link", async () => {
    const storage = await createSeededStorage()
    const createPlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_set_absent" }, ({ objects }) => {
        objects(Invoice)
          .byId("inv_1")
          .setLink(Invoice.l.customer, objects(Customer).byId("cus_1"), {
            properties: { role: "billTo" },
          })
      }),
    })
    expect(createPlan.diff.links).toEqual([
      {
        operation: "create",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
      },
    ])

    await seedInvoiceCustomerLink(storage, {
      role: "billTo",
      since: "2026-06-01T00:00:00.000Z",
    })
    const updatePlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_set_same" }, ({ objects }) => {
        objects(Invoice)
          .byId("inv_1")
          .setLink(Invoice.l.customer, objects(Customer).byId("cus_1"), {
            properties: { role: "shipTo" },
          })
      }),
    })
    expect(updatePlan.diff.links[0]?.operation).toBe("update")
    expect(updatePlan.links.upserts[0]?.properties).toEqual({
      role: "shipTo",
      since: "2026-06-01T00:00:00.000Z",
    })

    const noOpPlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_set_noop" }, ({ objects }) => {
        objects(Invoice)
          .byId("inv_1")
          .setLink(Invoice.l.customer, objects(Customer).byId("cus_1"), {
            properties: { role: "billTo" },
          })
      }),
    })
    expect(noOpPlan.diff.links).toEqual([])
  })

  test("atomically replaces and clears the current target with existing event types", async () => {
    const storage = await createSeededStorage()
    await seedSecondCustomer(storage)
    await seedInvoiceCustomerLink(storage)
    await queueRunningRun(storage, "run_replace_customer", "assignCustomer")

    const result = await commitActionEditBatch({
      storage,
      projectId: "project-a",
      runId: "run_replace_customer",
      actionId: "assignCustomer",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch: await recordRuntimeEdits({ runId: "run_replace_customer" }, ({ objects }) => {
        objects(Invoice)
          .byId("inv_1")
          .setLink(Invoice.l.customer, objects(Customer).byId("cus_2"), {
            properties: { role: "shipTo" },
          })
      }),
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
    })

    expect(result.commit.events.map((event) => event.type)).toEqual([
      "link.deleted",
      "link.created",
    ])
    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Invoice",
      objectId: "inv_1",
      linkId: "customer",
    })
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ targetId: "cus_2", properties: { role: "shipTo" } })

    const clearPlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_clear_customer" }, ({ objects }) => {
        objects(Invoice).byId("inv_1").clearLink(Invoice.l.customer)
      }),
    })
    expect(clearPlan.diff.links).toEqual([
      {
        operation: "delete",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_2" },
      },
    ])
  })

  test("applies assignments in order and rejects assignment semantics on many links", async () => {
    const storage = await createSeededStorage()
    await seedSecondCustomer(storage)
    const orderedPlan = await planEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: await recordRuntimeEdits({ runId: "act_ordered_links" }, ({ objects }) => {
        const invoice = objects(Invoice).byId("inv_1")
        invoice.setLink(Invoice.l.customer, objects(Customer).byId("cus_1"), {
          properties: { role: "first" },
        })
        invoice.setLink(Invoice.l.customer, objects(Customer).byId("cus_2"), {
          properties: { role: "second" },
        })
      }),
    })
    expect(orderedPlan.diff.links).toEqual([
      {
        operation: "create",
        source: { objectTypeId: "Invoice", primaryId: "inv_1" },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_2" },
      },
    ])

    await expect(
      recordRuntimeEdits({ runId: "act_set_many" }, ({ objects }) => {
        objects(Invoice).byId("inv_1").setLink(Invoice.l.reviewers, objects(Customer).byId("cus_1"))
      })
    ).rejects.toThrow("setLink requires cardinality 'one' link 'Invoice.reviewers'")

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: {
          kind: "link.clear",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "reviewers",
        },
      })
    ).rejects.toThrow("does not have cardinality 'one'")
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
        previousProperties: { role: "billTo" },
        operation: "update",
      },
    ])
  })

  test("re-creating a deleted link replaces (does not merge) the prior properties", async () => {
    const storage = await createSeededStorage()
    await storage.objects.applyLinkUpsert({
      id: "evt_link_props",
      schemaVersion: 1,
      projectId: "project-a",
      type: "link.created",
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
        propertyChanges: {},
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
        previousProperties: { role: "old" },
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
    await storage.objects.applyObjectUpsert({
      id: "evt_customer_2",
      schemaVersion: 1,
      projectId: "project-a",
      type: "object.created",
      topic: "objects",
      partitionKey: "Customer:cus_2",
      occurredAt: "2026-06-01T00:00:00.000Z",
      cursor: "evt_customer_2",
      payload: {
        objectTypeId: "Customer",
        primaryId: "cus_2",
        properties: { id: "cus_2", name: "Second Customer" },
        propertyChanges: {},
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
        previousProperties: { role: "billTo" },
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
        previousProperties: { id: "inv_1", amount: 120, status: "draft" },
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

describe("commitActionEditBatch serialization retry", () => {
  function alwaysFailingStorage(makeError: () => Error): {
    storage: Storage
    attempts: () => number
  } {
    let attempts = 0
    const storage: Storage = {
      ...new InMemoryStorage(),
      transaction: async () => {
        attempts++
        throw makeError()
      },
    }
    return { storage, attempts: () => attempts }
  }

  const conflict = () =>
    new StorageTransactionError("serialization conflict", { code: "serialization_failure" })

  async function exhaustionInput(runId: string, serializationRetry: SerializationRetryOptions) {
    return {
      projectId: "project-a",
      runId,
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" } as const,
      ontology,
      batch: await recordRuntimeEdits({ runId }, ({ objects }) => {
        objects(Invoice).byId("inv_1").update({ status: "paid" })
      }),
      serializationRetry,
    }
  }

  test("retries up to the attempt cap, then surfaces the serialization failure", async () => {
    const { storage, attempts } = alwaysFailingStorage(conflict)

    await expect(
      commitActionEditBatch({
        storage,
        ...(await exhaustionInput("run_exhaust", { sleep: noopSleep })),
      })
    ).rejects.toThrow(StorageTransactionError)

    // Default cap is 3 attempts (the first plus two retries).
    expect(attempts()).toBe(3)
  })

  test("does not retry a non-serialization failure", async () => {
    const { storage, attempts } = alwaysFailingStorage(() => new Error("boom"))

    await expect(
      commitActionEditBatch({
        storage,
        ...(await exhaustionInput("run_passthrough", { sleep: noopSleep })),
      })
    ).rejects.toThrow("boom")

    expect(attempts()).toBe(1)
  })

  test("honors a custom maxAttempts cap", async () => {
    const { storage, attempts } = alwaysFailingStorage(conflict)

    await expect(
      commitActionEditBatch({
        storage,
        ...(await exhaustionInput("run_custom_cap", { sleep: noopSleep, maxAttempts: 5 })),
      })
    ).rejects.toThrow(StorageTransactionError)

    expect(attempts()).toBe(5)
  })

  test("rolls back a failed attempt and replays the commit against the restored state", async () => {
    const storage = await createSeededStorage()
    await seedInvoiceCustomerLink(storage)
    await queueRunningRun(storage, "run_rollback_replay", "markPaid")

    let attempts = 0
    const storageWithRollback: Storage = {
      ...storage,
      transaction: (run, options) => {
        attempts++
        if (attempts === 1) {
          // Let the first attempt perform its real writes, then force a serialization failure so the
          // in-memory transaction actually rolls them back (object update + recorded commit) before
          // the retry runs against the restored state.
          return storage.transaction(async (tx) => {
            await run(tx)
            throw new StorageTransactionError("serialization conflict", {
              code: "serialization_failure",
            })
          }, options)
        }
        return storage.transaction(run, options)
      },
    }

    const batch = await recordRuntimeEdits({ runId: "run_rollback_replay" }, ({ objects }) => {
      objects(Invoice).byId("inv_1").update({ status: "paid" })
    })

    const result = await commitActionEditBatch({
      storage: storageWithRollback,
      projectId: "project-a",
      runId: "run_rollback_replay",
      actionId: "markPaid",
      subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
      ontology,
      batch,
      committedAt: new Date("2026-06-02T00:00:00.000Z"),
      serializationRetry: { sleep: noopSleep },
    })

    const invoice = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })
    const run = await requireActionRuns(storage.actionRuns).getById({
      projectId: "project-a",
      id: "run_rollback_replay",
    })

    expect(attempts).toBe(2)
    // `created: true` proves the first attempt's recorded commit was rolled back: a leaked commit
    // would route the retry into the idempotent branch (`created: false`). Version 2 proves the
    // update applied exactly once rather than twice.
    expect(result.commit.created).toBe(true)
    expect(invoice?.properties.status).toBe("paid")
    expect(invoice?.version).toBe(2)
    expect(run?.commit?.committedAt).toEqual(new Date("2026-06-02T00:00:00.000Z"))
  })
})

describe("commitActionEditBatch concurrency (provider serialization)", () => {
  test("serializes concurrent upserts of the same object", async () => {
    const storage = await createSeededStorage()
    await queueRunningRun(storage, "run_upsert_pending", "syncPayment")
    await queueRunningRun(storage, "run_upsert_settled", "syncPayment")

    const subject = { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" } as const
    const batchA = await recordRuntimeEdits({ runId: "run_upsert_pending" }, ({ objects }) => {
      objects(Payment).upsert({ id: "pay_race", status: "pending" })
    })
    const batchB = await recordRuntimeEdits({ runId: "run_upsert_settled" }, ({ objects }) => {
      objects(Payment).upsert({ id: "pay_race", status: "settled" })
    })

    const results = await Promise.allSettled([
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_upsert_pending",
        actionId: "syncPayment",
        subject,
        ontology,
        batch: batchA,
      }),
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_upsert_settled",
        actionId: "syncPayment",
        subject,
        ontology,
        batch: batchB,
      }),
    ])

    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    const payment = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Payment",
      primaryId: "pay_race",
    })
    expect(payment?.version).toBe(2)
    expect(
      payment?.properties.status === "pending" || payment?.properties.status === "settled"
    ).toBe(true)
  })

  test("serializes concurrent assignments as last-committed-writer-wins", async () => {
    const storage = await createSeededStorage()
    await seedSecondCustomer(storage)
    await queueRunningRun(storage, "run_set_cus_1", "assignCustomer")
    await queueRunningRun(storage, "run_set_cus_2", "assignCustomer")

    const subject = { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" } as const
    const batchA = await recordRuntimeEdits({ runId: "run_set_cus_1" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .setLink(Invoice.l.customer, objects(Customer).byId("cus_1"), {
          properties: { role: "payer" },
        })
    })
    const batchB = await recordRuntimeEdits({ runId: "run_set_cus_2" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .setLink(Invoice.l.customer, objects(Customer).byId("cus_2"), {
          properties: { role: "payer" },
        })
    })

    const results = await Promise.allSettled([
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_set_cus_1",
        actionId: "assignCustomer",
        subject,
        ontology,
        batch: batchA,
      }),
      commitActionEditBatch({
        storage,
        projectId: "project-a",
        runId: "run_set_cus_2",
        actionId: "assignCustomer",
        subject,
        ontology,
        batch: batchB,
      }),
    ])

    expect(results.every((result) => result.status === "fulfilled")).toBe(true)
    const links = await storage.objects.listLinks({
      projectId: "project-a",
      objectTypeId: "Invoice",
      objectId: "inv_1",
      linkId: "customer",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId === "cus_1" || links[0]?.targetId === "cus_2").toBe(true)
  })

  // In-memory and SQLite serialize transactions on a single connection/lock, so the PG e2e's
  // barrier (which waits for both commits to reach `applyEditCommitPlan`) would deadlock here — the
  // second transaction cannot start until the first finishes. That serialization *is* the guarantee
  // under test: two commits racing on a cardinality-one link resolve to exactly one winner.
  test("serializes concurrent commits racing on a cardinality-one link", async () => {
    const storage = await createSeededStorage()
    await seedSecondCustomer(storage)
    await queueRunningRun(storage, "run_link_cus_1", "linkCustomer")
    await queueRunningRun(storage, "run_link_cus_2", "linkCustomer")

    const subject = { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" } as const
    const batchA = await recordRuntimeEdits({ runId: "run_link_cus_1" }, ({ objects }) => {
      objects(Invoice)
        .byId("inv_1")
        .link(Invoice.l.customer, objects(Customer).byId("cus_1"), {
          properties: { role: "payer" },
        })
    })
    const batchB = await recordRuntimeEdits({ runId: "run_link_cus_2" }, ({ objects }) => {
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
  })
})

async function queueRunningRun(
  storage: InMemoryStorage,
  runId: string,
  actionId: string
): Promise<void> {
  await storage.actionRuns.queue({
    id: runId,
    projectId: "project-a",
    actionId,
    subject: { kind: "object", objectTypeId: "Invoice", primaryId: "inv_1" },
    params: {},
    idempotencyKey: `action:project-a:${runId}`,
  })
  await storage.actionRuns.start({ id: runId, projectId: "project-a" })
}

async function seedSecondCustomer(storage: InMemoryStorage): Promise<void> {
  await storage.objects.applyObjectUpsert({
    id: "evt_customer_2",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.created",
    topic: "objects",
    partitionKey: "Customer:cus_2",
    occurredAt: "2026-06-01T00:00:00.000Z",
    cursor: "evt_customer_2",
    payload: {
      objectTypeId: "Customer",
      primaryId: "cus_2",
      properties: { id: "cus_2", name: "Globex" },
      propertyChanges: {},
    },
  })
}

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

  await storage.objects.applyObjectUpsert({
    id: "evt_customer_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.created",
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
      propertyChanges: {},
    },
  })
  await storage.objects.applyObjectUpsert({
    id: "evt_invoice_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.created",
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
      propertyChanges: {},
    },
  })
  await storage.objects.applyObjectUpsert({
    id: "evt_payment_1",
    schemaVersion: 1,
    projectId: "project-a",
    type: "object.created",
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
      propertyChanges: {},
    },
  })

  return storage
}

async function seedInvoiceCustomerLink(
  storage: InMemoryStorage,
  properties: Record<string, unknown> = { role: "billTo" }
): Promise<void> {
  await storage.objects.applyLinkUpsert({
    id: "evt_invoice_customer",
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.created",
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
      properties,
      propertyChanges: {},
    },
  })
}

async function seedPaymentInvoiceLink(storage: InMemoryStorage): Promise<void> {
  await storage.objects.applyLinkUpsert({
    id: "evt_payment_invoice",
    schemaVersion: 1,
    projectId: "project-a",
    type: "link.created",
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
      propertyChanges: {},
    },
  })
}
