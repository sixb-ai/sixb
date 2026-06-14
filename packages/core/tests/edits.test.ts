import { describe, expect, test } from "bun:test"
import {
  createEditBuilder,
  defineObjectType,
  defineValueType,
  deriveEditCommitDiff,
  type EditBatch,
  InMemoryStorage,
  link,
  OntologyRegistry,
  prop,
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

describe("EditBatch core contract", () => {
  test("normalizes fluent and array edits into one serializable batch", async () => {
    const storage = await createSeededStorage()
    const edit = createEditBuilder({ runId: "act_1" })
    const createdInvoice = edit.create(Invoice, {
      amount: 250,
      status: "draft",
    })
    const customer = edit.object(Customer, "cus_1")

    expect(JSON.parse(JSON.stringify(createdInvoice))).toEqual({
      objectTypeId: "Invoice",
      primaryId: createdInvoice.primaryId,
    })

    edit.set(createdInvoice, { status: "sent" })
    edit.link(createdInvoice, Invoice.l.customer, customer, {
      properties: { role: "billTo" },
    })

    const result = await validateEditBatch({
      projectId: "project-a",
      ontology,
      storage,
      batch: edit.toEditBatch(),
    })

    expect(result.batch.operations).toEqual([
      {
        kind: "object.create",
        objectTypeId: "Invoice",
        primaryId: createdInvoice.primaryId,
        properties: {
          id: createdInvoice.primaryId,
          amount: 250,
          status: "draft",
        },
      },
      {
        kind: "object.update",
        objectTypeId: "Invoice",
        primaryId: createdInvoice.primaryId,
        properties: {
          status: "sent",
        },
      },
      {
        kind: "link.create",
        source: { objectTypeId: "Invoice", primaryId: createdInvoice.primaryId },
        linkId: "customer",
        target: { objectTypeId: "Customer", primaryId: "cus_1" },
        properties: { role: "billTo" },
      },
    ])
    expect(result.diff).toEqual({
      objects: [
        {
          objectTypeId: "Invoice",
          primaryId: createdInvoice.primaryId,
          operation: "create",
          changedProperties: ["amount", "id", "status"],
        },
      ],
      links: [
        {
          operation: "create",
          source: { objectTypeId: "Invoice", primaryId: createdInvoice.primaryId },
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
      batch: createEditBuilder({ runId: "act_readonly" }).set(Invoice, "inv_1", {
        status: "paid",
      }),
    })

    const row = await storage.objects.getByPrimaryId({
      projectId: "project-a",
      objectTypeId: "Invoice",
      primaryId: "inv_1",
    })

    expect(row?.properties.status).toBe("draft")
  })

  test("normalizes builder edits with resolved and registered value type refs", async () => {
    const resolvedEdit = createEditBuilder({ runId: "act_value_type_resolved" })
    const resolvedInvoice = resolvedEdit.create(InvoiceWithResolvedAmount, {
      total: { value: 120, currency: "EUR" },
    })

    expect(resolvedEdit.toEditBatch().operations[0]).toEqual({
      kind: "object.create",
      objectTypeId: "InvoiceWithResolvedAmount",
      primaryId: resolvedInvoice.primaryId,
      properties: {
        id: resolvedInvoice.primaryId,
        total: { value: 120, currency: "EUR" },
      },
    })

    const registeredEdit = createEditBuilder<[typeof MoneyAmount]>({
      runId: "act_value_type_registered",
      valueTypesById: new Map([[MoneyAmount.id, MoneyAmount]]),
    })
    const registeredInvoice = registeredEdit.create(InvoiceWithRegisteredAmount, {
      total: { value: 240, currency: "USD" },
    })

    expect(registeredEdit.toEditBatch().operations[0]).toEqual({
      kind: "object.create",
      objectTypeId: "InvoiceWithRegisteredAmount",
      primaryId: registeredInvoice.primaryId,
      properties: {
        id: registeredInvoice.primaryId,
        total: { value: 240, currency: "USD" },
      },
    })
  })

  test("rejects invalid local mutations before commit", async () => {
    const storage = await createSeededStorage()
    const edit = createEditBuilder({ runId: "act_3" })

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: edit.set(Invoice, "missing", { status: "paid" }),
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

    const edit = createEditBuilder({ runId: "act_4" })

    await expect(
      validateEditBatch({
        projectId: "project-a",
        ontology,
        storage,
        batch: edit.link(
          edit.ref(Invoice, "inv_1"),
          Invoice.l.customer,
          edit.object(Customer, "cus_2"),
          {
            properties: { role: "shipTo" },
          }
        ),
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
    const edit = createEditBuilder({ runId: "act_6" })

    const diff = await deriveEditCommitDiff({
      projectId: "project-a",
      ontology,
      storage,
      batch: edit.object(Payment, "pay_1").delete(),
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
})

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
