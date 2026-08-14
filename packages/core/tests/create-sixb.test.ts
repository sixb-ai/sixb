import { afterEach, describe, expect, jest, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  col,
  createSixb,
  defineAction,
  defineConnector,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineRule,
  defineSchedule,
  defineSync,
  defineValueType,
  defineWorkflow,
  defineWorkflowStep,
  events,
  fromForeignKey,
  link,
  ProjectionValidationError,
  prop,
  ref,
} from "../src"
import { EVENTS_STREAM } from "../src/events"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

const rawHubspotCompaniesDataset = defineDataset("raw.hubspot.companies", {
  schema: [col("id", "string")],
})

const rawHubspotOrdersDataset = defineDataset("raw.hubspot.orders", {
  schema: [col("id", "string")],
})

const canonicalRoomsDataset = defineDataset("canonical.rooms", {
  schema: [col("room_id", "string"), col("room_name", "string"), col("building_ref", "string")],
})

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

describe("createSixb", () => {
  test("discovers ontology, actions, syncs, and connectors from project folders", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "actions/setTemperature.ts",
      `import { defineAction, param } from "${coreModuleUrl}"
import { Room } from "../ontology/room"

export const setTemperature = defineAction("setTemperature")
  .on(Room)
  .params({ target: param("double") })
  .writeback(async () => {})
`
    )

    await writeProjectFile(
      projectRoot,
      "connectors/erpDb.ts",
      `import { defineConnector } from "${coreModuleUrl}"

export const erpDb = defineConnector("erpDb", {
  type: "test",
  connect() {
    return { source: "discovered" }
  },
})
`
    )

    await writeProjectFile(
      projectRoot,
      "datasets/orders.ts",
      `import { col, defineDataset } from "${coreModuleUrl}"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("source", "string", { nullable: true })],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "syncs/orders.ts",
      `import { defineSync } from "${coreModuleUrl}"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ source }) => [{ source }])
  .intoDataset(rawOrdersDataset)
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    const { erpDb } = await import(pathToFileURL(join(projectRoot, "connectors", "erpDb.ts")).href)
    await import(pathToFileURL(join(projectRoot, "ontology", "room.ts")).href)
    const client = await createTestSixb(sixb).connector(erpDb)

    expect(sixb.definitions.actions.list().map((action) => action.id)).toEqual(["setTemperature"])
    expect(
      sixb.definitions.actions
        .listForType(sixb.definitions.ontology.listObjectTypes()[0])
        .map((action) => action.id)
    ).toEqual(["setTemperature"])
    expect(sixb.definitions.datasets.list().map((dataset) => dataset.id)).toEqual([
      "raw.erp.orders",
    ])
    expect(sixb.definitions.syncs.list().map((sync) => sync.id)).toEqual(["sync-orders"])
    expect(sixb.definitions.syncs.getById("sync-orders")?.target.dataset.id).toBe("raw.erp.orders")
    expect(sixb.definitions.connectors.list().map((connector) => connector.id)).toEqual(["erpDb"])
    expect(client).toEqual({ source: "discovered" })
  })

  test("uses explicit workflows when provided", async () => {
    const projectRoot = await createTempProjectRoot()

    const Transaction = defineObjectType({
      id: "Transaction",
      name: "Transaction",
      properties: [prop("id", "string", { required: true, primary: true })],
    })

    const normalizeTransaction = defineWorkflowStep("normalize-transaction")
      .input({
        transaction: ref(Transaction),
      })
      .output({
        transaction: ref(Transaction),
      })
      .run(({ input }) => ({ transaction: input.transaction }))

    const workflow = defineWorkflow("explicit-transaction-workflow")
      .input({
        transaction: ref(Transaction),
      })
      .then(normalizeTransaction)

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Transaction],
      workflows: [workflow],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.workflows.list()).toEqual([workflow])
    expect(sixb.definitions.workflows.getById("explicit-transaction-workflow")).toBe(workflow)
    expect(sixb.definitions.workflows.getById("missing-workflow")).toBeNull()
  })

  test("uses explicit event schedules when provided", async () => {
    const projectRoot = await createTempProjectRoot()

    const Transaction = defineObjectType({
      id: "Transaction",
      name: "Transaction",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "double"),
      ],
    })

    const schedule = defineSchedule("transaction.high-value")
      .on(events.object(Transaction).updated())
      .where((event) => event.object.p.amount.gt(500))

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Transaction],
      schedules: [schedule],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.schedules.list()).toEqual([schedule])
    expect(sixb.definitions.schedules.getById("transaction.high-value")).toBe(schedule)
  })

  test("validates rule and action event schedules against registered definitions", async () => {
    const projectRoot = await createTempProjectRoot()
    const Invoice = defineObjectType({
      id: "Invoice",
      name: "Invoice",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "double"),
      ],
    })
    const invoiceAtRisk = defineRule("invoice.at-risk")
      .on(Invoice)
      .where((invoice) => invoice.p.amount.gt(500))
    const approveInvoice = defineAction("approve-invoice")
      .on(Invoice)
      .params({})
      .writeback(async () => {})
    const schedules = [
      defineSchedule("invoice.at-risk-triggered").on(events.rule(invoiceAtRisk).triggered()),
      defineSchedule("invoice.approved").on(events.action(approveInvoice).completed()),
    ]

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Invoice],
      actions: [approveInvoice],
      rules: [invoiceAtRisk],
      schedules,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.schedules.list()).toEqual(schedules)
  })

  test("discovers workflows from workflows directory", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/transaction.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [prop("id", "string", { required: true, primary: true })],
})

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "actions/attachInvoice.ts",
      `import { defineAction, param, ref } from "${coreModuleUrl}"
import { Invoice, Transaction } from "../ontology/transaction"

export const attachInvoice = defineAction("attach-invoice")
  .on(Transaction)
  .params({
    invoice: param(ref(Invoice)),
  })
  .writeback(async () => {})
`
    )

    await writeProjectFile(
      projectRoot,
      "schedules/daily.ts",
      `import { defineSchedule } from "${coreModuleUrl}"

export const daily = defineSchedule("daily-reconciliation").cron("0 6 * * *")
`
    )

    await writeProjectFile(
      projectRoot,
      "workflows/reconcileTransaction.ts",
      `import { defineWorkflow, defineWorkflowStep, ref } from "${coreModuleUrl}"
import { attachInvoice } from "../actions/attachInvoice"
import { Invoice, Transaction } from "../ontology/transaction"
import { daily } from "../schedules/daily"

const findBestInvoice = defineWorkflowStep("find-best-invoice")
  .input({})
  .output({
    transaction: ref(Transaction),
    invoice: ref(Invoice),
    confidence: "double",
  })
  .run(() => ({
    transaction: { objectTypeId: "Transaction", primaryId: "transaction:1" },
    invoice: { objectTypeId: "Invoice", primaryId: "invoice:1" },
    confidence: 0.98,
  }))

export const reconcileTransaction = defineWorkflow("reconcile-transaction")
  .input({})
  .when(daily)
  .then(findBestInvoice)
  .then(attachInvoice, ({ steps }) => ({
    target: steps.findBestInvoice.transaction,
    params: {
      invoice: steps.findBestInvoice.invoice,
    },
  }))
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.workflows.list().map((workflow) => workflow.id)).toEqual([
      "reconcile-transaction",
    ])
    expect(sixb.definitions.workflows.getById("reconcile-transaction")?.triggers).toEqual([
      { type: "schedule", scheduleId: "daily-reconciliation" },
    ])
    expect(
      sixb.definitions.workflows.getById("reconcile-transaction")?.nodes.map((node) => node.id)
    ).toEqual(["find-best-invoice", "attach-invoice"])
  })

  test("discovers event schedules from schedules directory", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/transaction.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double"),
  ],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "schedules/highValueTransaction.ts",
      `import { defineSchedule, events } from "${coreModuleUrl}"
import { Transaction } from "../ontology/transaction"

export const highValueTransaction = defineSchedule("transaction.high-value")
  .on(events.object(Transaction).updated())
  .where((event) => event.object.p.amount.gt(500))
`
    )

    await writeProjectFile(
      projectRoot,
      "workflows/reviewHighValueTransaction.ts",
      `import { defineWorkflow, defineWorkflowStep, ref } from "${coreModuleUrl}"
import { Transaction } from "../ontology/transaction"
import { highValueTransaction } from "../schedules/highValueTransaction"

const reviewTransaction = defineWorkflowStep("review-transaction")
  .input({
    transaction: ref(Transaction),
  })
  .output({})
  .run(() => ({}))

export const reviewHighValueTransaction = defineWorkflow("review-high-value-transaction")
  .input({
    transaction: ref(Transaction),
  })
  .when(highValueTransaction, ({ event }) => ({
    transaction: {
      objectTypeId: "Transaction",
      primaryId: event.object.primaryId,
    },
  }))
  .then(reviewTransaction)
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.schedules.list().map((schedule) => schedule.id)).toEqual([
      "transaction.high-value",
    ])
    expect(
      sixb.definitions.workflows.getById("review-high-value-transaction")?.triggers
    ).toMatchObject([{ type: "schedule", scheduleId: "transaction.high-value" }])
  })

  test("uses explicit ontologies when provided", async () => {
    const projectRoot = await createTempProjectRoot()
    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("externalId", "string", { required: true }),
        prop("name", "string", { required: true }),
      ],
    })

    const runtimeDeps = createTestRuntimeDeps()
    const host = await createSixb({
      projectRoot,
      ontologies: [Room],
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)

    const room = await sixb.objects(Room).upsert({
      properties: {
        id: "room:102",
        externalId: "RM-102",
        name: "Conference 102",
      },
    })

    expect(room.primaryId).toBe("room:102")
    const file = await sixb.blobs.put({ body: new TextEncoder().encode("configured provider") })
    expect(await runtimeDeps.blobStorage.stat(file.blobId)).not.toBeNull()
  })

  test("wires broker-backed events through runtime writes and schedules", async () => {
    jest.useFakeTimers()

    const projectRoot = await createTempProjectRoot()
    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
      ],
    })
    const hourly = defineSchedule("hourly").cron("0 * * * *")
    const runtimeDeps = createTestRuntimeDeps()
    const host = await createSixb({
      projectRoot,
      id: "broker-backed-runtime",
      ontologies: [Room],
      schedules: [hourly],
      ...runtimeDeps,
    })
    const sixb = createTestSixb(host)

    try {
      await sixb.objects(Room).upsert({
        properties: { id: "room:broker" },
      })
      await sixb
        .objects(Room)
        .byId("room:broker")
        .telemetry(Room.p.temperature)
        .append({
          value: 71,
          unit: "degreeFahrenheit",
          at: new Date("2026-05-20T10:00:00.000Z"),
        })

      await host.scheduler.start()
      jest.advanceTimersByTime(60 * 60_000)
      await host.scheduler.stop()

      // Runtime shutdown tracks the non-blocking outbox notifications before closing the broker.
      await host.closeBroker()
      const eventTypes = (await sixb.events.read()).map((event) => event.type)
      expect(eventTypes).toEqual(
        expect.arrayContaining(["object.created", "telemetry.appended", "schedule.triggered"])
      )

      const brokerRecordNames = (
        await runtimeDeps.broker.read({
          projectId: "broker-backed-runtime",
          streamId: EVENTS_STREAM.id,
        })
      ).records.map((record) => record.name)
      expect(brokerRecordNames).toEqual(eventTypes)
    } finally {
      await host.scheduler.stop()
      jest.useRealTimers()
    }
  })

  test("throws when ontologies is not provided and folder is missing", async () => {
    const projectRoot = await createTempProjectRoot()

    await expect(
      createSixb({
        projectRoot,
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow("No ontology found")
  })

  test("treats missing actions and syncs folders as empty", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("externalId", "string", { required: true }),
    prop("name", "string", { required: true }),
  ],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.actions.list()).toEqual([])
    expect(sixb.definitions.syncs.list()).toEqual([])
    expect(sixb.definitions.connectors.list()).toEqual([])
  })

  test("merges explicit connectors with auto-discovery", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const hubspot = defineConnector("hubspot", {
      type: "test",
      connect() {
        return { source: "explicit" }
      },
    })

    await writeProjectFile(
      projectRoot,
      "connectors/erpDb.ts",
      `import { defineConnector } from "${coreModuleUrl}"

export const erpDb = defineConnector("erpDb", {
  type: "test",
  connect() {
    return { source: "discovered" }
  },
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      connectors: [hubspot],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.connectors.list().map((connector) => connector.id)).toEqual([
      "hubspot",
      "erpDb",
    ])
  })

  test("rejects duplicate connector ids across explicit and discovered connectors", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const duplicate = defineConnector("erpDb", {
      type: "test",
      connect() {
        return { source: "explicit" }
      },
    })

    await writeProjectFile(
      projectRoot,
      "connectors/erpDb.ts",
      `import { defineConnector } from "${coreModuleUrl}"

export const erpDb = defineConnector("erpDb", {
  type: "test",
  connect() {
    return { source: "discovered" }
  },
})
`
    )

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        connectors: [duplicate],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow("Duplicate connector id: erpDb")
  })

  test("merges explicit syncs with auto-discovery", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const hubspot = defineConnector("hubspot", {
      type: "test",
      connect() {
        return { source: "explicit" }
      },
    })

    const syncHubspot = defineSync("sync-hubspot")
      .from(hubspot)
      .read(() => [])
      .intoDataset(rawHubspotCompaniesDataset)

    await writeProjectFile(
      projectRoot,
      "connectors/erpDb.ts",
      `import { defineConnector } from "${coreModuleUrl}"

export const erpDb = defineConnector("erpDb", {
  type: "test",
  connect() {
    return { source: "discovered" }
  },
})
`
    )

    await writeProjectFile(
      projectRoot,
      "datasets/orders.ts",
      `import { col, defineDataset } from "${coreModuleUrl}"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("id", "string")],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "syncs/orders.ts",
      `import { defineSync } from "${coreModuleUrl}"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(() => [])
  .intoDataset(rawOrdersDataset)
`
    )

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      datasets: [rawHubspotCompaniesDataset],
      connectors: [hubspot],
      syncs: [syncHubspot],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.syncs.list().map((sync) => sync.id)).toEqual([
      "sync-hubspot",
      "sync-orders",
    ])
  })

  test("rejects duplicate sync ids across explicit and discovered syncs", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const hubspot = defineConnector("hubspot", {
      type: "test",
      connect() {
        return { source: "explicit" }
      },
    })

    const duplicate = defineSync("sync-orders")
      .from(hubspot)
      .read(() => [])
      .intoDataset(rawHubspotOrdersDataset)

    await writeProjectFile(
      projectRoot,
      "connectors/erpDb.ts",
      `import { defineConnector } from "${coreModuleUrl}"

export const erpDb = defineConnector("erpDb", {
  type: "test",
  connect() {
    return { source: "discovered" }
  },
})
`
    )

    await writeProjectFile(
      projectRoot,
      "datasets/orders.ts",
      `import { col, defineDataset } from "${coreModuleUrl}"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("id", "string")],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "syncs/orders.ts",
      `import { defineSync } from "${coreModuleUrl}"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(() => [])
  .intoDataset(rawOrdersDataset)
`
    )

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [rawHubspotOrdersDataset],
        connectors: [hubspot],
        syncs: [duplicate],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow("Duplicate sync id: sync-orders")
  })
})

describe("ontologies", () => {
  test("loads ObjectTypes from an OntologyDocumentInput", async () => {
    const projectRoot = await createTempProjectRoot()

    const Sensor = defineObjectType({
      id: "Sensor",
      name: "Sensor",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("value", "double"),
      ],
    })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [
        {
          id: "test-ontology",
          version: "1.0.0",
          objectTypes: [Sensor],
        },
      ],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.getObjectTypeById("Sensor")).not.toBeNull()
  })

  test("merges ontologies with auto-discovery", async () => {
    const projectRoot = await createTempProjectRoot()

    const Equipment = defineObjectType({
      id: "Equipment",
      name: "Equipment",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Equipment],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.getObjectTypeById("Equipment")).not.toBeNull()
    expect(sixb.definitions.ontology.getObjectTypeById("Room")).not.toBeNull()
  })

  test("resolves extends cross-source (auto-discovered extends ontologies type)", async () => {
    const projectRoot = await createTempProjectRoot()

    const Equipment = defineObjectType({
      id: "Equipment",
      name: "Equipment",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    await writeProjectFile(
      projectRoot,
      "ontology/myType.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const MyEquipment = defineObjectType({
  id: "MyEquipment",
  name: "My Equipment",
  extends: "Equipment",
  properties: [prop("name", "string"), prop("custom", "boolean")],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Equipment],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.listSubTypes("Equipment")).toContain("MyEquipment")
  })

  test("loads ValueTypes from OntologyDocumentInput", async () => {
    const projectRoot = await createTempProjectRoot()

    const Temperature = defineValueType({
      id: "Temperature",
      name: "Temperature",
      schema: "double",
    })

    const MyType = defineObjectType({
      id: "MyType",
      name: "MyType",
      properties: [prop("id", "string", { required: true, primary: true })],
    })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [
        MyType,
        {
          id: "test-vt",
          version: "1.0.0",
          objectTypes: [],
          valueTypes: [Temperature],
        },
      ],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.getObjectTypeById("MyType")).not.toBeNull()
    // ValueTypes are loaded (no error thrown)
  })

  test("deduplicates when same type ref appears in ontologies and auto-discovery", async () => {
    const projectRoot = await createTempProjectRoot()

    // Write a shared module that both ontologies and ontology/ reference
    await writeProjectFile(
      projectRoot,
      "shared/sensor.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true }), prop("value", "double")],
})
`
    )

    // ontology/ re-exports the same JS object
    await writeProjectFile(
      projectRoot,
      "ontology/sensor.ts",
      `export { Sensor } from "${pathToFileURL(join(projectRoot, "shared", "sensor.ts")).href}"
`
    )

    // Import the same JS object to pass via ontologies
    const { Sensor } = await import(pathToFileURL(join(projectRoot, "shared", "sensor.ts")).href)

    // Same JS reference in both — collectOntology deduplicates by ref identity
    const sixb = await createSixb({
      projectRoot,
      ontologies: [Sensor],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.getObjectTypeById("Sensor")).not.toBeNull()
  })

  test("ontologies alone is sufficient (no ontology folder needed)", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.getObjectTypeById("Room")).not.toBeNull()
  })
})

describe("projections", () => {
  test("discovers projections from projections/ directory", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop, link } from "${coreModuleUrl}"

export const Building = defineObjectType({
  id: "Building",
  name: "Building",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
  ],
})

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("buildingRef", "string"),
  ],
  links: [link("inBuilding", Building, { cardinality: "one" })],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "datasets/rooms.ts",
      `import { col, defineDataset } from "${coreModuleUrl}"

export const canonicalRoomsDataset = defineDataset("canonical.rooms", {
  schema: [
    col("room_id", "string"),
    col("room_name", "string"),
    col("building_ref", "string"),
  ],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "projections/room-projection.ts",
      `import { defineProjection, fromForeignKey } from "${coreModuleUrl}"
import { canonicalRoomsDataset } from "../datasets/rooms"
import { Room, Building } from "../ontology/room"

export const roomProjection = defineProjection("room-proj", Room)
  .fromDataset(canonicalRoomsDataset)
  .properties({
    id: "room_id",
    name: "room_name",
    buildingRef: "building_ref",
  })
  .withLinks({
    inBuilding: fromForeignKey({
      link: Room.l.inBuilding,
      sourceProperty: Room.p.buildingRef,
      target: Building,
    }),
  })
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.projections.listObjects()).toHaveLength(1)
    expect(sixb.definitions.projections.listObjects()[0].id).toBe("room-proj")
    expect(sixb.definitions.projections.listObjects()[0].objectTypeId).toBe("Room")
    expect(sixb.definitions.projections.listObjects()[0].datasetId).toBe("canonical.rooms")
    expect(sixb.definitions.projections.listLinks()).toHaveLength(0)
    expect(sixb.definitions.projections.listTelemetry()).toHaveLength(0)
  })

  test("discovers telemetry projections from projections/ directory", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "datasets/room-readings.ts",
      `import { col, defineDataset } from "${coreModuleUrl}"

export const roomReadingsDataset = defineDataset("canonical.room-readings", {
  schema: [
    col("room_id", "string"),
    col("observed_at", "timestamp"),
    col("temperature", "float64"),
  ],
})
`
    )

    await writeProjectFile(
      projectRoot,
      "projections/room-temperatures.ts",
      `import { defineProjection } from "${coreModuleUrl}"
import { roomReadingsDataset } from "../datasets/room-readings"
import { Room } from "../ontology/room"

export const roomTemperatureProjection = defineProjection(
  "room-temperatures",
  Room.p.temperature
)
  .fromDataset(roomReadingsDataset)
  .points({
    objectId: "room_id",
    at: "observed_at",
    value: "temperature",
  })
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.projections.listObjects()).toHaveLength(0)
    expect(sixb.definitions.projections.listLinks()).toHaveLength(0)
    expect(sixb.definitions.projections.listTelemetry()).toHaveLength(1)
    expect(sixb.definitions.projections.listTelemetry()[0].id).toBe("room-temperatures")
    expect(sixb.definitions.projections.listTelemetry()[0].objectTypeId).toBe("Room")
    expect(sixb.definitions.projections.listTelemetry()[0].propertyId).toBe("temperature")
    expect(sixb.definitions.projections.listTelemetry()[0].datasetId).toBe(
      "canonical.room-readings"
    )
  })

  test("registers explicit projections", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const roomProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      datasets: [canonicalRoomsDataset],
      projections: [roomProjection],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.projections.listObjects()).toHaveLength(1)
    expect(sixb.definitions.projections.listObjects()[0].id).toBe("room-proj")
  })

  test("merges explicit projections with discovered projections", async () => {
    // `actions` and `projections` used to *replace* discovery while the other eleven families merged.
    // The test above passes either way, because its temp root is empty.
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const explicitProjection = defineProjection("explicit-rooms", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })

    // A different object type: two projections cannot both own one type's existence.
    await writeProjectFile(
      projectRoot,
      "projections/discovered-buildings.ts",
      `import { defineProjection } from "${coreModuleUrl}"
import { canonicalRoomsDataset } from "../datasets/canonical-rooms"
import { Building } from "../ontology/room"

export const discoveredBuildings = defineProjection("discovered-buildings", Building)
  .fromDataset(canonicalRoomsDataset)
  .properties({ id: "room_id", name: "room_name" })
`
    )
    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

export const Building = defineObjectType({
  id: "Building",
  name: "Building",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})
`
    )
    await writeProjectFile(
      projectRoot,
      "datasets/canonical-rooms.ts",
      `import { col, defineDataset } from "${coreModuleUrl}"

export const canonicalRoomsDataset = defineDataset("canonical.rooms", {
  schema: [col("room_id", "string"), col("room_name", "string")],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      projections: [explicitProjection],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.projections.listObjects().map((projection) => projection.id)).toEqual([
      "explicit-rooms",
      "discovered-buildings",
    ])
  })

  test("rejects duplicate action ids across explicit and discovered actions", async () => {
    // The merge turned a silent override into a startup failure. That is the point: two definitions
    // claiming one id is a mistake, and a project that relied on the override must see it.
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`
    )
    await writeProjectFile(
      projectRoot,
      "actions/setTemperature.ts",
      `import { defineAction, param } from "${coreModuleUrl}"
import { Room } from "../ontology/room"

export const setTemperature = defineAction("setTemperature")
  .on(Room)
  .params({ target: param("double") })
  .writeback(async () => {})
`
    )

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const duplicate = defineAction("setTemperature")
      .on(Room)
      .params({})
      .writeback(async () => {})

    await expect(
      createSixb({ projectRoot, actions: [duplicate], ...createTestRuntimeDeps() })
    ).rejects.toThrow("setTemperature")
  })

  test("uses explicit telemetry projections when provided", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("temperature", "double", { mode: "telemetry" }),
      ],
    })
    const roomReadingsDataset = defineDataset("canonical.room-readings", {
      schema: [
        col("room_id", "string"),
        col("observed_at", "timestamp"),
        col("temperature", "float64"),
      ],
    })

    const telemetryProjection = defineProjection("room-temperatures", Room.p.temperature)
      .fromDataset(roomReadingsDataset)
      .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      datasets: [roomReadingsDataset],
      projections: [telemetryProjection],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.projections.listObjects()).toHaveLength(0)
    expect(sixb.definitions.projections.listLinks()).toHaveLength(0)
    const registered = sixb.definitions.projections.listTelemetry()[0]
    expect(registered).toEqual(telemetryProjection)
    expect(registered).not.toBe(telemetryProjection)
    expect(Object.isFrozen(registered)).toBe(true)
    expect(sixb.definitions.projections.getById("room-temperatures")).toBe(registered)
  })

  test("looks up object and link projections by id", async () => {
    const projectRoot = await createTempProjectRoot()

    const Sensor = defineObjectType({
      id: "Sensor",
      name: "Sensor",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
      links: [link("hasSensors", Sensor, { cardinality: "many" })],
    })
    const roomSensorsDataset = defineDataset("canonical.room-sensors", {
      schema: [col("room_id", "string"), col("sensor_id", "string")],
    })

    const roomProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
    const roomSensorProjection = defineProjection("room-sensor-proj", Room.l.hasSensors)
      .fromDataset(roomSensorsDataset)
      .sourceField("room_id")
      .targetField("sensor_id")

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room, Sensor],
      datasets: [canonicalRoomsDataset, roomSensorsDataset],
      projections: [roomProjection, roomSensorProjection],
      ...createTestRuntimeDeps(),
    })

    const registeredObjects = sixb.definitions.projections.listObjects()
    const registeredLinks = sixb.definitions.projections.listLinks()
    expect(sixb.definitions.projections.getById("room-proj")).toBe(registeredObjects[0])
    expect(sixb.definitions.projections.getById("room-sensor-proj")).toBe(registeredLinks[0])
    expect(registeredObjects[0]).not.toBe(roomProjection)
    expect(registeredLinks[0]).not.toBe(roomSensorProjection)
    expect(Object.isFrozen(registeredObjects)).toBe(true)
    expect(Object.isFrozen(registeredLinks)).toBe(true)
    expect(sixb.definitions.projections.getById("missing")).toBeNull()
  })

  test("rejects duplicate projection ids", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const firstProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
    const secondProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id" })

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [firstProjection, secondProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [firstProjection, secondProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow("Duplicate projection id: room-proj")
  })

  test("validates projection referencing unknown dataset", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const roomProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('unknown dataset "canonical.rooms"')
  })

  test("validates projection referencing unknown dataset column", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const roomProjection = {
      _tag: "ObjectProjectionDefinition" as const,
      id: "room-proj",
      objectTypeId: "Room",
      datasetId: "canonical.rooms",
      properties: { id: "room_id", name: "missing_column" },
      links: {},
    }

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('unknown dataset column "missing_column"')
  })

  test("validates telemetry projection referencing unknown dataset", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("temperature", "double", { mode: "telemetry" }),
      ],
    })
    const roomReadingsDataset = defineDataset("canonical.room-readings", {
      schema: [
        col("room_id", "string"),
        col("observed_at", "timestamp"),
        col("temperature", "float64"),
      ],
    })
    const telemetryProjection = defineProjection("room-temperatures", Room.p.temperature)
      .fromDataset(roomReadingsDataset)
      .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        projections: [telemetryProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        projections: [telemetryProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('unknown dataset "canonical.room-readings"')
  })

  test("validates telemetry projection referencing unknown dataset column", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("temperature", "double", { mode: "telemetry" }),
      ],
    })
    const roomReadingsDataset = defineDataset("canonical.room-readings", {
      schema: [
        col("room_id", "string"),
        col("observed_at", "timestamp"),
        col("temperature", "float64"),
      ],
    })
    const telemetryProjection = {
      _tag: "TelemetryProjectionDefinition" as const,
      id: "room-temperatures",
      objectTypeId: "Room",
      propertyId: "temperature",
      datasetId: "canonical.room-readings",
      objectIdField: "room_id",
      atField: "missing_observed_at",
      valueField: "temperature",
    }

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [roomReadingsDataset],
        projections: [telemetryProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [roomReadingsDataset],
        projections: [telemetryProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('at field "missing_observed_at" references unknown dataset column')
  })

  test("validates telemetry projection targeting a telemetry property", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("temperature", "double"),
      ],
    })
    const roomReadingsDataset = defineDataset("canonical.room-readings", {
      schema: [
        col("room_id", "string"),
        col("observed_at", "timestamp"),
        col("temperature", "float64"),
      ],
    })
    const telemetryProjection = {
      _tag: "TelemetryProjectionDefinition" as const,
      id: "room-temperatures",
      objectTypeId: "Room",
      propertyId: "temperature",
      datasetId: "canonical.room-readings",
      objectIdField: "room_id",
      atField: "observed_at",
      valueField: "temperature",
    }

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [roomReadingsDataset],
        projections: [telemetryProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [roomReadingsDataset],
        projections: [telemetryProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('property "temperature" on type "Room" must be telemetry-enabled')
  })

  test("treats missing projections folder as empty", async () => {
    const projectRoot = await createTempProjectRoot()

    await writeProjectFile(
      projectRoot,
      "ontology/room.ts",
      `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})
`
    )

    const sixb = await createSixb({
      projectRoot,
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.projections.listObjects()).toEqual([])
    expect(sixb.definitions.projections.listLinks()).toEqual([])
    expect(sixb.definitions.projections.listTelemetry()).toEqual([])
  })

  test("validates projection referencing unknown type", async () => {
    const projectRoot = await createTempProjectRoot()

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const roomProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })

    // Only register a different type, not Room
    const Other = defineObjectType({
      id: "Other",
      name: "Other",
      properties: [prop("id", "string", { required: true, primary: true })],
    })

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Other],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Other],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('unknown object type "Room"')
  })

  test("validates FK link referencing unknown target type", async () => {
    const projectRoot = await createTempProjectRoot()

    const Building = defineObjectType({
      id: "Building",
      name: "Building",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })

    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("name", "string"),
        prop("buildingRef", "string"),
      ],
      links: [link("inBuilding", Building, { cardinality: "one" })],
    })

    const roomProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name", buildingRef: "building_ref" })
      .withLinks({
        inBuilding: fromForeignKey({
          link: Room.l.inBuilding,
          sourceProperty: Room.p.buildingRef,
          target: Building,
        }),
      })

    // Register Room but not Building → FK target unknown
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toBeInstanceOf(ProjectionValidationError)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow('target type "Building" is unknown')
  })
})

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-create-sixb-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(projectRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, "utf-8")
}
