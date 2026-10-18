import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  type CreateSixbOptions,
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
  valueTypeRef,
} from "../src"
import { EVENTS_STREAM } from "../src/events"
import { InMemoryConnectorConnectionStorage } from "../src/storage/connector-connections"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A fake-timer test that times out never reaches its own cleanup; keep it from leaking.
afterEach(() => {
  jest.useRealTimers()
})

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href

const rawHubspotCompaniesDataset = defineDataset("raw.hubspot.companies", {
  schema: [col("id", "string")],
})

const rawHubspotOrdersDataset = defineDataset("raw.hubspot.orders", {
  schema: [col("id", "string")],
})

const canonicalRoomsDataset = defineDataset("canonical.rooms", {
  schema: [col("room_id", "string"), col("room_name", "string"), col("building_ref", "string")],
})

const hubspot = defineConnector("hubspot", {
  type: "test",
  connect() {
    return { source: "explicit" }
  },
})

// Explicit-only tests share one empty root, so discovery finds nothing and every definition is the
// one the test passes. `project` holds one module per discovery family, written once.
let emptyRoot: string
let project: string

beforeAll(async () => {
  emptyRoot = await mkdtemp(join(tmpdir(), "sixb-core-create-sixb-empty-"))
  project = await mkdtemp(join(tmpdir(), "sixb-core-create-sixb-project-"))
  await writeProjectFiles(project, discoveryProjectFiles())
})

afterAll(async () => {
  await rm(emptyRoot, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe("createSixb", () => {
  test("forwards OAuth connector connection protection to the host", async () => {
    const Record = defineObjectType({
      id: "Record",
      name: "Record",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const oauthConnector = defineConnector("social", {
      type: "test-oauth",
      authentication: {
        type: "oauth2",
        authorizationUrl() {
          return "https://provider.test/oauth/authorize"
        },
        exchangeCode() {
          return { accessToken: "unused" }
        },
        refresh() {
          return { accessToken: "unused" }
        },
      },
      discoverAccounts() {
        return []
      },
      connect() {
        return {}
      },
    })
    const dependencies = createTestRuntimeDeps()
    const durable =
      new InMemoryConnectorConnectionStorage() as InMemoryConnectorConnectionStorage & {
        durability: "durable"
      }
    Object.defineProperty(durable, "durability", { value: "durable" })
    Object.defineProperty(dependencies.storage, "connectorConnections", { value: durable })

    await expect(
      createSixb({
        projectRoot: emptyRoot,
        ontologies: [Record],
        connectors: [oauthConnector],
        connectorConnections: {
          encryptionKey: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url"),
        },
        ...dependencies,
      })
    ).resolves.toBeDefined()
  })

  test("registers explicit definitions without project folders", async () => {
    const Transaction = defineObjectType({
      id: "Transaction",
      name: "Transaction",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("amount", "double"),
      ],
    })
    const Room = defineObjectType({
      id: "Room",
      name: "Room",
      properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
    })
    const normalizeTransaction = defineWorkflowStep("normalize-transaction")
      .input({ transaction: ref(Transaction) })
      .output({ transaction: ref(Transaction) })
      .run(({ input }) => ({ transaction: input.transaction }))
    const workflow = defineWorkflow("explicit-transaction-workflow")
      .input({ transaction: ref(Transaction) })
      .then(normalizeTransaction)
    const largeTransaction = defineRule("transaction.large")
      .on(Transaction)
      .where((transaction) => transaction.p.amount.gt(500))
    // The rule-triggered schedule validates only if the host passes registered rules to schedule
    // validation.
    const schedules = [
      defineSchedule("transaction.high-value")
        .on(events.object(Transaction).updated())
        .where((event) => event.object.p.amount.gt(500)),
      defineSchedule("transaction.large-triggered").on(events.rule(largeTransaction).triggered()),
    ]
    const roomProjection = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })

    const sixb = await createSixb({
      projectRoot: emptyRoot,
      ontologies: [Transaction, Room],
      datasets: [canonicalRoomsDataset],
      rules: [largeTransaction],
      schedules,
      workflows: [workflow],
      projections: [roomProjection],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.ontology.listObjectTypes().map((type) => type.id)).toEqual([
      "Transaction",
      "Room",
    ])
    expect(sixb.definitions.rules.list()).toEqual([largeTransaction])
    expect(sixb.definitions.schedules.list()).toEqual(schedules)
    expect(sixb.definitions.workflows.list()).toEqual([workflow])
    expect(sixb.definitions.projections.listObjects().map((projection) => projection.id)).toEqual([
      "room-proj",
    ])
  })

  test("discovers definitions from every project folder", async () => {
    const sixb = await createSixb({ projectRoot: project, ...createTestRuntimeDeps() })
    const definitions = sixb.definitions

    const { erpDb } = await import(pathToFileURL(join(project, "connectors", "erpDb.ts")).href)
    expect(await createTestSixb(sixb).connector(erpDb)).toEqual({ source: "discovered" })
    expect(definitions.connectors.list().map((connector) => connector.id)).toEqual(["erpDb"])

    const room = definitions.ontology.getObjectTypeById("Room")
    expect(room).not.toBeNull()
    expect(definitions.actions.list().map((action) => action.id)).toEqual([
      "acknowledge-report",
      "attach-invoice",
      "setTemperature",
    ])
    expect(room && definitions.actions.listForType(room).map((action) => action.id)).toEqual([
      "setTemperature",
    ])
    expect(definitions.datasets.list().map((dataset) => dataset.id)).toEqual([
      "raw.erp.orders",
      "canonical.room-readings",
      "canonical.rooms",
    ])
    expect(definitions.syncs.list().map((sync) => sync.id)).toEqual(["sync-orders"])
    expect(definitions.syncs.getById("sync-orders")?.target.dataset.id).toBe("raw.erp.orders")

    expect(definitions.schedules.list().map((schedule) => schedule.id)).toEqual([
      "daily-reconciliation",
      "transaction.high-value",
    ])
    expect(
      definitions.workflows
        .list()
        .map((workflow) => ({ id: workflow.id, triggers: workflow.triggers }))
    ).toMatchObject([
      {
        id: "reconcile-transaction",
        triggers: [{ type: "schedule", scheduleId: "daily-reconciliation" }],
      },
      {
        id: "review-high-value-transaction",
        triggers: [{ type: "schedule", scheduleId: "transaction.high-value" }],
      },
    ])
    expect(
      definitions.workflows.getById("reconcile-transaction")?.nodes.map((node) => node.id)
    ).toEqual(["find-best-invoice", "attach-invoice"])

    expect(definitions.projections.listObjects().map((projection) => projection.id)).toEqual([
      "room-proj",
    ])
    expect(definitions.projections.listTelemetry().map((projection) => projection.id)).toEqual([
      "room-temperatures",
    ])

    // The role grants a discovered Share, so Shares must be registered before security validates.
    expect(definitions.shares.list().map((share) => share.id)).toEqual(["published-report"])
    expect(definitions.security.getRoleById("publisher")?.grants[0]).toMatchObject({
      capability: "share",
      selection: { ids: ["published-report"] },
    })
  })

  test("registers explicit definitions ahead of discovered ones", async () => {
    // `actions` and `projections` used to *replace* discovery while the other families merged; a
    // root without discovered definitions passes either way.
    const syncHubspot = defineSync("sync-hubspot")
      .from(hubspot)
      .read(() => [])
      .intoDataset(rawHubspotCompaniesDataset)
    // A different object type: two projections cannot both own one type's existence.
    const Building = defineObjectType({
      id: "Building",
      name: "Building",
      properties: [prop("id", "string", { required: true, primary: true })],
    })
    const explicitBuildings = defineProjection("explicit-buildings", Building)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "building_ref" })

    const sixb = await createSixb({
      projectRoot: project,
      datasets: [rawHubspotCompaniesDataset],
      connectors: [hubspot],
      syncs: [syncHubspot],
      projections: [explicitBuildings],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.definitions.connectors.list().map((connector) => connector.id)).toEqual([
      "hubspot",
      "erpDb",
    ])
    expect(sixb.definitions.syncs.list().map((sync) => sync.id)).toEqual([
      "sync-hubspot",
      "sync-orders",
    ])
    expect(sixb.definitions.projections.listObjects().map((projection) => projection.id)).toEqual([
      "explicit-buildings",
      "room-proj",
    ])
  })

  // Merging turned a silent override into a startup failure. That is the point: two definitions
  // claiming one id is a mistake, and a project that relied on the override must see it.
  test.each([
    {
      kind: "connector",
      options: {
        connectors: [defineConnector("erpDb", { type: "test", connect: () => ({}) })],
      },
      message: "Duplicate connector id: erpDb",
    },
    {
      kind: "sync",
      options: {
        datasets: [rawHubspotOrdersDataset],
        connectors: [hubspot],
        syncs: [
          defineSync("sync-orders")
            .from(hubspot)
            .read(() => [])
            .intoDataset(rawHubspotOrdersDataset),
        ],
      },
      message: "Duplicate sync id: sync-orders",
    },
    {
      kind: "action",
      options: {
        actions: [
          defineAction("setTemperature")
            .on(
              defineObjectType({
                id: "Room",
                name: "Room",
                properties: [prop("id", "string", { required: true, primary: true })],
              })
            )
            .params({})
            .writeback(async () => {}),
        ],
      },
      message: 'Duplicate action id "setTemperature"',
    },
  ] satisfies {
    kind: string
    options: Partial<CreateSixbOptions>
    message: string
  }[])("rejects an explicit $kind whose id a discovered one already uses", async ({
    options,
    message,
  }) => {
    await expect(
      createSixb({ projectRoot: project, ...options, ...createTestRuntimeDeps() })
    ).rejects.toThrow(message)
  })

  test("merges explicit ontologies with discovered ones", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-create-sixb-ontology-"))
    try {
      const sharedSensorUrl = pathToFileURL(join(projectRoot, "shared", "sensor.ts")).href
      await writeProjectFiles(projectRoot, {
        "shared/sensor.ts": `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true }), prop("value", "double")],
})
`,
        // ontology/ re-exports the object the config also passes, so the registry must deduplicate
        // by identity instead of rejecting a duplicate id.
        "ontology/sensor.ts": `export { Sensor } from "${sharedSensorUrl}"\n`,
        // Extends a type that only the explicit ontologies provide.
        "ontology/my-equipment.ts": `import { defineObjectType, prop } from "${coreModuleUrl}"

export const MyEquipment = defineObjectType({
  id: "MyEquipment",
  name: "My Equipment",
  extends: "Equipment",
  properties: [prop("name", "string"), prop("custom", "boolean")],
})
`,
      })
      const Equipment = defineObjectType({
        id: "Equipment",
        name: "Equipment",
        properties: [
          prop("id", "string", { required: true, primary: true }),
          prop("name", "string"),
        ],
      })
      const { Sensor } = await import(sharedSensorUrl)

      const sixb = await createSixb({
        projectRoot,
        ontologies: [Equipment, Sensor],
        ...createTestRuntimeDeps(),
      })

      expect(
        sixb.definitions.ontology
          .listObjectTypes()
          .map((type) => type.id)
          .sort()
      ).toEqual(["Equipment", "MyEquipment", "Sensor"])
      expect(sixb.definitions.ontology.listSubTypes("Equipment")).toContain("MyEquipment")
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  test("wires broker-backed events through runtime writes and schedules", async () => {
    jest.useFakeTimers()

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
      projectRoot: emptyRoot,
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
})

describe("projection validation at startup", () => {
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
      prop("reading", "double"),
      prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
      prop("humidity", "double", { mode: "telemetry" }),
    ],
    links: [link("inBuilding", Building, { cardinality: "one" })],
  })
  const readings = defineDataset("canonical.room-readings", {
    schema: [
      col("room_id", "string"),
      col("observed_at", "timestamp"),
      col("temperature", "float64"),
      col("temperature_unit", "string"),
      col("humidity", "float64"),
      col("humidity_unit", "string"),
    ],
  })
  const roomProjection = defineProjection("room-proj", Room)
    .fromDataset(canonicalRoomsDataset)
    .properties({ id: "room_id", name: "room_name" })
  const humidityProjection = defineProjection("room-humidity", Room.p.humidity)
    .fromDataset(readings)
    .points({ objectId: "room_id", at: "observed_at", value: "humidity" })
  const AmbientTemperature = defineValueType({
    id: "lib:AmbientTemperature",
    name: "AmbientTemperature",
    schema: "double",
    semanticType: "Temperature",
  })
  const Probe = defineObjectType({
    id: "Probe",
    name: "Probe",
    properties: [
      prop("id", "string", { required: true, primary: true }),
      prop("ambient", valueTypeRef(AmbientTemperature), { mode: "telemetry" }),
    ],
  })
  const probeReadings = defineDataset("probe-readings", {
    schema: [
      col("probe_id", "string"),
      col("observed_at", "timestamp"),
      col("ambient", "float64"),
      col("ambient_unit", "string"),
    ],
  })
  const probeProjection = (unit: boolean) =>
    defineProjection("probe-ambient", Probe)
      .fromDataset(probeReadings)
      .points({
        objectId: "probe_id",
        at: "observed_at",
        properties: { ambient: unit ? { value: "ambient", unit: "ambient_unit" } : "ambient" },
      })

  test.each([
    {
      name: "duplicate projection ids",
      options: {
        datasets: [canonicalRoomsDataset],
        projections: [
          roomProjection,
          defineProjection("room-proj", Room)
            .fromDataset(canonicalRoomsDataset)
            .properties({ id: "room_id" }),
        ],
      },
      message: "Duplicate projection id: room-proj",
    },
    {
      name: "an object projection reading an unknown dataset",
      options: { projections: [roomProjection] },
      message: 'unknown dataset "canonical.rooms"',
    },
    {
      name: "an object projection reading an unknown dataset column",
      options: {
        datasets: [canonicalRoomsDataset],
        projections: [
          {
            _tag: "ObjectProjectionDefinition" as const,
            id: "room-proj",
            objectTypeId: "Room",
            datasetId: "canonical.rooms",
            properties: { id: "room_id", name: "missing_column" },
            links: {},
          },
        ],
      },
      message: 'unknown dataset column "missing_column"',
    },
    {
      name: "a projection onto an unknown object type",
      options: {
        ontologies: [Building],
        datasets: [canonicalRoomsDataset],
        projections: [roomProjection],
      },
      message: 'unknown object type "Room"',
    },
    {
      name: "a foreign-key link to an unknown target type",
      options: {
        ontologies: [Room],
        datasets: [canonicalRoomsDataset],
        projections: [
          defineProjection("room-proj", Room)
            .fromDataset(canonicalRoomsDataset)
            .properties({ id: "room_id", buildingRef: "building_ref" })
            .withLinks({
              inBuilding: fromForeignKey({
                link: Room.l.inBuilding,
                sourceProperty: Room.p.buildingRef,
                target: Building,
              }),
            }),
        ],
      },
      message: 'target type "Building" is unknown',
    },
    {
      name: "a telemetry projection reading an unknown dataset",
      options: { projections: [humidityProjection] },
      message: 'unknown dataset "canonical.room-readings"',
    },
    {
      name: "a telemetry projection reading an unknown dataset column",
      options: {
        datasets: [readings],
        projections: [
          {
            _tag: "TelemetryProjectionDefinition" as const,
            id: "room-humidity",
            objectTypeId: "Room",
            datasetId: "canonical.room-readings",
            objectIdField: "room_id",
            atField: "missing_observed_at",
            properties: { humidity: { valueField: "humidity" } },
          },
        ],
      },
      message: 'at field "missing_observed_at" references unknown dataset column',
    },
    {
      name: "a telemetry projection onto a property without telemetry",
      options: {
        datasets: [readings],
        projections: [
          {
            _tag: "TelemetryProjectionDefinition" as const,
            id: "room-readings",
            objectTypeId: "Room",
            datasetId: "canonical.room-readings",
            objectIdField: "room_id",
            atField: "observed_at",
            properties: { reading: { valueField: "temperature" } },
          },
        ],
      },
      message: 'property "reading" on type "Room" must be telemetry-enabled',
    },
    {
      name: "a semantic-typed property without a unit field",
      options: {
        datasets: [readings],
        projections: [
          defineProjection("missing-unit", Room)
            .fromDataset(readings)
            .points({
              objectId: "room_id",
              at: "observed_at",
              properties: { temperature: "temperature" },
            }),
        ],
      },
      message:
        'property "temperature" requires a unit field because it uses semantic type "Temperature"',
    },
    {
      name: "a unit field on a property without a semantic type",
      options: {
        datasets: [readings],
        projections: [
          defineProjection("unexpected-unit", Room)
            .fromDataset(readings)
            .points({
              objectId: "room_id",
              at: "observed_at",
              properties: { humidity: { value: "humidity", unit: "humidity_unit" } },
            }),
        ],
      },
      message: 'property "humidity" cannot map a unit field because it has no semantic type',
    },
    {
      // Remove the `semanticType` spread from `extractValueTypesFromSchema` in
      // `src/ontology/registry.ts` to see this fail: the value type registered through its ref
      // loses "Temperature" and the projection is accepted without a unit field.
      name: "a value type registered only through its ref, without a unit field",
      options: {
        ontologies: [Probe],
        datasets: [probeReadings],
        projections: [probeProjection(false)],
      },
      message:
        'property "ambient" requires a unit field because it uses semantic type "Temperature"',
    },
  ] satisfies {
    name: string
    options: Partial<CreateSixbOptions>
    message: string
  }[])("rejects $name", async ({ options, message }) => {
    const error = await createSixb({
      projectRoot: emptyRoot,
      ontologies: [Room, Building],
      ...options,
      ...createTestRuntimeDeps(),
    }).then(
      () => undefined,
      (rejection: unknown) => rejection
    )

    expect(error).toBeInstanceOf(ProjectionValidationError)
    expect(error).toMatchObject({ message: expect.stringContaining(message) })
  })

  test("accepts unit fields exactly where the property's semantic type requires them", async () => {
    const grouped = defineProjection("room-activity", Room)
      .fromDataset(readings)
      .points({
        objectId: "room_id",
        at: "observed_at",
        properties: {
          temperature: { value: "temperature", unit: "temperature_unit" },
          humidity: "humidity",
        },
      })

    await expect(
      createSixb({
        projectRoot: emptyRoot,
        ontologies: [Room, Building, Probe],
        datasets: [readings, probeReadings],
        projections: [grouped, probeProjection(true)],
        ...createTestRuntimeDeps(),
      })
    ).resolves.toBeDefined()
  })
})

function discoveryProjectFiles(): Record<string, string> {
  return {
    "ontology/room.ts": `import { defineObjectType, link, prop } from "${coreModuleUrl}"

export const Building = defineObjectType({
  id: "Building",
  name: "Building",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

export const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("buildingRef", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link("inBuilding", Building, { cardinality: "one" })],
})
`,
    "ontology/report.ts": `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`,
    "ontology/transaction.ts": `import { defineObjectType, prop } from "${coreModuleUrl}"

export const Transaction = defineObjectType({
  id: "Transaction",
  name: "Transaction",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("amount", "double"),
  ],
})

export const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})
`,
    "actions/setTemperature.ts": `import { defineAction, param } from "${coreModuleUrl}"
import { Room } from "../ontology/room"

export const setTemperature = defineAction("setTemperature")
  .on(Room)
  .params({ target: param("double") })
  .writeback(async () => {})
`,
    "actions/attachInvoice.ts": `import { defineAction, param, ref } from "${coreModuleUrl}"
import { Invoice, Transaction } from "../ontology/transaction"

export const attachInvoice = defineAction("attach-invoice")
  .on(Transaction)
  .params({ invoice: param(ref(Invoice)) })
  .writeback(async () => {})
`,
    "actions/acknowledge.ts": `import { defineAction } from "${coreModuleUrl}"
import { Report } from "../ontology/report"

export const acknowledge = defineAction("acknowledge-report")
  .on(Report)
  .params({})
  .edits(() => {})
`,
    "connectors/erpDb.ts": `import { defineConnector } from "${coreModuleUrl}"

export const erpDb = defineConnector("erpDb", {
  type: "test",
  connect() {
    return { source: "discovered" }
  },
})
`,
    "datasets/orders.ts": `import { col, defineDataset } from "${coreModuleUrl}"

export const rawOrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("source", "string", { nullable: true })],
})
`,
    "datasets/room-readings.ts": `import { col, defineDataset } from "${coreModuleUrl}"

export const roomReadingsDataset = defineDataset("canonical.room-readings", {
  schema: [
    col("room_id", "string"),
    col("observed_at", "timestamp"),
    col("temperature", "float64"),
  ],
})
`,
    "datasets/rooms.ts": `import { col, defineDataset } from "${coreModuleUrl}"

export const canonicalRoomsDataset = defineDataset("canonical.rooms", {
  schema: [
    col("room_id", "string"),
    col("room_name", "string"),
    col("building_ref", "string"),
  ],
})
`,
    "syncs/orders.ts": `import { defineSync } from "${coreModuleUrl}"
import { erpDb } from "../connectors/erpDb"
import { rawOrdersDataset } from "../datasets/orders"

export const syncOrders = defineSync("sync-orders")
  .from(erpDb)
  .read(({ source }) => [{ source }])
  .intoDataset(rawOrdersDataset)
`,
    "schedules/daily.ts": `import { defineSchedule } from "${coreModuleUrl}"

export const daily = defineSchedule("daily-reconciliation").cron("0 6 * * *")
`,
    "schedules/highValueTransaction.ts": `import { defineSchedule, events } from "${coreModuleUrl}"
import { Transaction } from "../ontology/transaction"

export const highValueTransaction = defineSchedule("transaction.high-value")
  .on(events.object(Transaction).updated())
  .where((event) => event.object.p.amount.gt(500))
`,
    "workflows/reconcileTransaction.ts": `import { defineWorkflow, defineWorkflowStep, ref } from "${coreModuleUrl}"
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
`,
    "workflows/reviewHighValueTransaction.ts": `import { defineWorkflow, defineWorkflowStep, ref } from "${coreModuleUrl}"
import { Transaction } from "../ontology/transaction"
import { highValueTransaction } from "../schedules/highValueTransaction"

const reviewTransaction = defineWorkflowStep("review-transaction")
  .input({ transaction: ref(Transaction) })
  .output({})
  .run(() => ({}))

export const reviewHighValueTransaction = defineWorkflow("review-high-value-transaction")
  .input({ transaction: ref(Transaction) })
  .when(highValueTransaction, ({ event }) => ({
    transaction: {
      objectTypeId: "Transaction",
      primaryId: event.object.primaryId,
    },
  }))
  .then(reviewTransaction)
`,
    "projections/room-projection.ts": `import { defineProjection, fromForeignKey } from "${coreModuleUrl}"
import { canonicalRoomsDataset } from "../datasets/rooms"
import { Building, Room } from "../ontology/room"

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
`,
    "projections/room-temperatures.ts": `import { defineProjection } from "${coreModuleUrl}"
import { roomReadingsDataset } from "../datasets/room-readings"
import { Room } from "../ontology/room"

export const roomTemperatureProjection = defineProjection("room-temperatures", Room.p.temperature)
  .fromDataset(roomReadingsDataset)
  .points({
    objectId: "room_id",
    at: "observed_at",
    value: "temperature",
  })
`,
    "shares/published-report.ts": `import { can, defineShare } from "${coreModuleUrl}"
import { acknowledge } from "../actions/acknowledge"
import { Report } from "../ontology/report"

export const PublishedReport = defineShare("published-report", {
  target: Report,
  grants: ({ target }) => [can.view(target), can.apply(acknowledge).on(target)],
})
`,
    "security/groups/publishers.ts": `import { defineGroup } from "${coreModuleUrl}"

export const Publishers = defineGroup("publishers")
`,
    "security/roles/publisher.ts": `import { can, defineRole } from "${coreModuleUrl}"
import { PublishedReport } from "../../shares/published-report"
import { Publishers } from "../groups/publishers"

export const Publisher = defineRole("publisher", {
  grantedTo: [Publishers],
  grants: [can.share(PublishedReport)],
})
`,
  }
}

async function writeProjectFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, "utf-8")
  }
}
