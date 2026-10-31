import { describe, expect, test } from "bun:test"
import {
  can,
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineGroup,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRole,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  every,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  type PipelineDefinition,
  prop,
  ref,
  SixbHost,
  type WorkflowDefinition,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import {
  createTestSixb,
  createTestWorkflowExecution,
  recordTestActionRun,
  startTestPipelineRun,
  startTestSyncRun,
} from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("score", "integer", { mode: "telemetry" }),
  ],
})

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [
    prop("id", "string", {
      required: true,
      primary: true,
      query: { searchable: true, filterable: true },
    }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link("invoice", Invoice, { cardinality: "one" })],
})

const OrdersDataset = defineDataset("raw.erp.orders", {
  schema: [col("id", "string"), col("invoice_id", "string")],
})

const CustomersDataset = defineDataset("raw.crm.customers", {
  schema: [col("id", "string")],
})

const sourceConnector = defineConnector("source", {
  type: "test",
  async connect() {
    return {}
  },
})

const ordersSync = defineSync("sync-orders")
  .from(sourceConnector)
  .read(() => [])
  .intoDataset(OrdersDataset)

const customersSync = defineSync("sync-customers")
  .from(sourceConnector)
  .read(() => [])
  .intoDataset(CustomersDataset)

const normalizeOrdersStep = definePipelineStep("normalize-orders")
  .inputs({ orders: OrdersDataset })
  .output(OrdersDataset)
  .run(async () => {})

const normalizeCustomersStep = definePipelineStep("normalize-customers")
  .inputs({ customers: CustomersDataset })
  .output(CustomersDataset)
  .run(async () => {})

const ordersPipeline: PipelineDefinition =
  definePipeline("pipeline-orders").then(normalizeOrdersStep)
const customersPipeline: PipelineDefinition =
  definePipeline("pipeline-customers").then(normalizeCustomersStep)

const ordersContractProjection = defineProjection("orders-contracts", Contract)
  .fromDataset(OrdersDataset)
  .properties({ id: "id" })

const customersInvoiceProjection = defineProjection("customers-invoices", Invoice)
  .fromDataset(CustomersDataset)
  .properties({ id: "id" })

const ordersContractInvoiceProjection = defineProjection(
  "orders-contract-invoices",
  Contract.l.invoice
)
  .fromDataset(OrdersDataset)
  .sourceField("id")
  .targetField("invoice_id")

const sendContract = defineAction("send-contract")
  .on(Contract)
  .params({})
  .edits(() => {})

const reviewContract = defineWorkflowStep("review-contract")
  .input({ contract: ref(Contract) })
  .output({ contract: ref(Contract) })
  .run(async () => ({ contract: { objectTypeId: "contract", primaryId: "c1" } }))

// Widened to the base type so the registered array avoids the deep chain type.
const renewContract: WorkflowDefinition = defineWorkflow("renew-contract")
  .input({ contract: ref(Contract) })
  .then(reviewContract)

const commercial = defineGroup("commercial")
const operations = defineGroup("operations")
const admins = defineGroup("admins")
const writers = defineGroup("writers")
const reviewers = defineGroup("reviewers")

const contractOperator = defineRole("contract.operator", {
  grantedTo: [commercial],
  grants: [can.view(Contract), can.view(OrdersDataset), can.apply(sendContract)],
})

const operationsRunner = defineRole("operations.runner", {
  grantedTo: [operations],
  grants: [can.run(renewContract), can.run(ordersSync), can.run(ordersPipeline)],
})

const adminOperator = defineRole("admin.operator", {
  grantedTo: [admins],
  grants: [
    can.view(every.object()),
    can.view(every.dataset()),
    can.apply(every.action()),
    can.run(every.workflow()),
    can.run(every.sync()),
    can.run(every.pipeline()),
  ],
})

// Writes Contract only, and links from it: `view` on Invoice is what lets it name a link target.
const contractWriter = defineRole("contract.writer", {
  grantedTo: [writers],
  grants: [can.view(Contract), can.edit(Contract), can.view(Invoice)],
})

// Sees one contract only, through a condition, and the runs of the action on it.
const contractReviewer = defineRole("contract.reviewer", {
  grantedTo: [reviewers],
  grants: [can.view(Contract).where((contract) => contract.p.id.eq("c1")), can.apply(sendContract)],
})

async function createRuntime(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const sixb = new SixbHost({
    id: "test-project",
    ontology: [Contract, Invoice],
    datasets: [OrdersDataset, CustomersDataset],
    syncs: [ordersSync, customersSync],
    pipelines: [ordersPipeline, customersPipeline],
    projections: [
      ordersContractProjection,
      customersInvoiceProjection,
      ordersContractInvoiceProjection,
    ],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    actions: [sendContract],
    workflows: [renewContract],
    groups: [commercial, operations, admins, writers, reviewers],
    roles: [contractOperator, operationsRunner, adminOperator, contractWriter, contractReviewer],
    auth: options.auth === false ? undefined : { id: "test", kind: "dev" as const },
  })

  const setup = createTestSixb(sixb)
  await setup.objects.upsert("contract", { id: "c1" })
  await setup.objects.upsert("invoice", { id: "i1" })
  await setup.objects.upsertLink("contract", "c1", "invoice", {
    targetTypeId: "invoice",
    targetId: "i1",
  })
  await setup.objects.appendTelemetry("contract", [
    {
      id: "c1",
      properties: { temperature: 72.5 },
      at: new Date("2026-05-16T10:30:00.000Z"),
    },
  ])
  await setup.objects.appendTelemetry("invoice", [
    {
      id: "i1",
      properties: { score: 20 },
      at: new Date("2026-05-16T10:00:00.000Z"),
    },
  ])

  return { sixb, storage }
}

async function createApp(options: { readonly auth?: boolean } = {}) {
  const { sixb, storage } = await createRuntime(options)
  const app = createSixbApi(
    new SixbServer({ host: sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return { app, storage, host: sixb }
}

async function seedSession(
  storage: InMemoryStorage,
  groupIds: readonly string[],
  userId = "usr_1"
) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: "test-project",
    email: `${userId}@acme.com`,
  })
  for (const groupId of groupIds) {
    await storage.auth.groupMemberships.upsert({
      projectId: "test-project",
      userId,
      groupId,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return {
    headers: { cookie: `sixb_session_app=${credential.cookieValue}` },
    csrfHeaders: {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
      "x-sixb-csrf": "csrf_1",
      "content-type": "application/json",
    },
  }
}

async function seedRuleStates(storage: InMemoryStorage) {
  await storage.rules.applyTriggered({
    id: "evt_rule_contract",
    cursor: "evt_rule_contract",
    schemaVersion: 1,
    projectId: "test-project",
    type: "rule.triggered",
    topic: "rules",
    partitionKey: "contract-review:contract:c1",
    payload: {
      ruleId: "contract-review",
      subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
      triggeredAt: "2026-05-16T10:35:00.000Z",
    },
    occurredAt: "2026-05-16T10:35:00.000Z",
  })
  await storage.rules.applyTriggered({
    id: "evt_rule_invoice",
    cursor: "evt_rule_invoice",
    schemaVersion: 1,
    projectId: "test-project",
    type: "rule.triggered",
    topic: "rules",
    partitionKey: "invoice-review:invoice:i1",
    payload: {
      ruleId: "invoice-review",
      subject: { kind: "object", objectTypeId: "invoice", primaryId: "i1" },
      triggeredAt: "2026-05-16T10:40:00.000Z",
    },
    occurredAt: "2026-05-16T10:40:00.000Z",
  })
}

describe("authorized object routes", () => {
  test("object type metadata narrows to viewable types", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const admin = await seedSession(storage, ["admins"], "usr_admin")
    const listTypes = async (headers: HeadersInit) => {
      const response = await app.fetch(
        new Request("http://localhost/api/object-types", { headers })
      )
      expect(response.status).toBe(200)
      return (await response.json()) as { id: string; actions: { id: string }[] }[]
    }

    const operatorBody = await listTypes(operator.headers)
    expect(operatorBody.map((objectType) => objectType.id)).toEqual(["contract"])
    expect(operatorBody[0].actions.map((action) => action.id)).toEqual(["send-contract"])

    const hidden = await app.fetch(
      new Request("http://localhost/api/object-types/invoice", { headers: operator.headers })
    )
    expect(hidden.status).toBe(404)

    expect(await listTypes(runner.headers)).toEqual([])

    // Wildcard object and action grants expose every type and its actions.
    const adminBody = await listTypes(admin.headers)
    expect(adminBody.map((objectType) => objectType.id)).toEqual(["contract", "invoice"])
    expect(adminBody.find((objectType) => objectType.id === "contract")?.actions).toEqual([
      expect.objectContaining({ id: "send-contract" }),
    ])
  })

  test("broad listings narrow to viewable types and refuse a forbidden type by name", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])
    const ungranted = await seedSession(storage, [], "usr_ungranted")

    const response = await app.fetch(
      new Request("http://localhost/api/objects", { headers: session.headers })
    )
    const body = (await response.json()) as { objects: { objectTypeId: string }[] }

    expect(response.status).toBe(200)
    expect(body.objects.map((row) => row.objectTypeId)).toEqual(["contract"])

    const forbidden = await app.fetch(
      new Request("http://localhost/api/objects?objectTypeId=invoice", {
        headers: session.headers,
      })
    )
    expect(forbidden.status).toBe(403)

    // A principal with no grants lists nothing.
    const empty = await app.fetch(
      new Request("http://localhost/api/objects", { headers: ungranted.headers })
    )
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual({ objects: [], hasMore: false, total: 0 })
  })

  test("identity reads return 404 for both forbidden and missing objects", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const allowed = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1", { headers: session.headers })
    )
    expect(allowed.status).toBe(200)

    const forbidden = await app.fetch(
      new Request("http://localhost/api/objects/invoice/i1", { headers: session.headers })
    )
    expect(forbidden.status).toBe(404)
    expect(await forbidden.json()).toEqual({ error: "Object not found" })

    const missing = await app.fetch(
      new Request("http://localhost/api/objects/contract/missing", { headers: session.headers })
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: "Object not found" })
  })

  test("bulk telemetry history follows object view grants", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")

    const allowedBulk = await app.fetch(
      new Request("http://localhost/api/telemetry/history", {
        method: "POST",
        headers: operator.csrfHeaders,
        body: JSON.stringify({
          series: [
            { objectTypeId: "contract", objectId: "c1", propertyId: "temperature" },
            { objectTypeId: "contract", objectId: "missing", propertyId: "temperature" },
          ],
        }),
      })
    )
    expect(allowedBulk.status).toBe(200)
    expect(await allowedBulk.json()).toEqual({
      series: [
        {
          objectTypeId: "contract",
          objectId: "c1",
          propertyId: "temperature",
          points: [
            expect.objectContaining({
              objectTypeId: "contract",
              objectId: "c1",
              propertyId: "temperature",
              value: 72.5,
            }),
          ],
        },
        {
          objectTypeId: "contract",
          objectId: "missing",
          propertyId: "temperature",
          points: [],
        },
      ],
    })

    const forbiddenBulk = await app.fetch(
      new Request("http://localhost/api/telemetry/history", {
        method: "POST",
        headers: operator.csrfHeaders,
        body: JSON.stringify({
          series: [{ objectTypeId: "invoice", objectId: "i1", propertyId: "score" }],
        }),
      })
    )
    expect(forbiddenBulk.status).toBe(403)

    const mixedBulk = await app.fetch(
      new Request("http://localhost/api/telemetry/history", {
        method: "POST",
        headers: operator.csrfHeaders,
        body: JSON.stringify({
          series: [
            { objectTypeId: "contract", objectId: "c1", propertyId: "temperature" },
            { objectTypeId: "invoice", objectId: "i1", propertyId: "score" },
          ],
        }),
      })
    )
    expect(mixedBulk.status).toBe(403)

    const ungrantedBulk = await app.fetch(
      new Request("http://localhost/api/telemetry/history", {
        method: "POST",
        headers: runner.csrfHeaders,
        body: JSON.stringify({
          series: [{ objectTypeId: "contract", objectId: "c1", propertyId: "temperature" }],
        }),
      })
    )
    expect(ungrantedBulk.status).toBe(403)
  })

  test("object queries deny forbidden touched types with 403", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const denied = await app.fetch(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        headers: session.csrfHeaders,
        body: JSON.stringify({ query: { kind: "start", objectTypeId: "invoice" } }),
      })
    )
    expect(denied.status).toBe(403)

    const allowed = await app.fetch(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        headers: session.csrfHeaders,
        body: JSON.stringify({
          query: {
            kind: "limit",
            input: { kind: "start", objectTypeId: "contract" },
            limit: 10,
          },
        }),
      })
    )
    expect(allowed.status).toBe(200)
    const body = (await allowed.json()) as { objects: { primaryId: string }[] }
    expect(body.objects.map((row) => row.primaryId)).toEqual(["c1"])

    const deniedRefs = await app.fetch(
      new Request("http://localhost/api/objects/query", {
        method: "POST",
        headers: session.csrfHeaders,
        body: JSON.stringify({
          query: {
            kind: "refs",
            refs: [
              { objectTypeId: "contract", primaryId: "c1" },
              { objectTypeId: "invoice", primaryId: "i1" },
            ],
          },
        }),
      })
    )
    expect(deniedRefs.status).toBe(403)

    const filteredLinks = await app.fetch(
      new Request("http://localhost/api/objects/query/links", {
        method: "POST",
        headers: session.csrfHeaders,
        body: JSON.stringify({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "contract", primaryId: "c1" }],
          },
          direction: "outgoing",
          includeObjects: true,
        }),
      })
    )
    expect(filteredLinks.status).toBe(200)
    expect(await filteredLinks.json()).toMatchObject({
      objects: [{ objectTypeId: "contract", primaryId: "c1" }],
      links: [],
      hasMore: false,
    })

    const writer = await seedSession(storage, ["writers"], "usr_writer_links")
    const visibleLinks = await app.fetch(
      new Request("http://localhost/api/objects/query/links", {
        method: "POST",
        headers: writer.csrfHeaders,
        body: JSON.stringify({
          query: {
            kind: "refs",
            refs: [{ objectTypeId: "contract", primaryId: "c1" }],
          },
          direction: "outgoing",
          includeObjects: true,
        }),
      })
    )
    expect(visibleLinks.status).toBe(200)
    expect(await visibleLinks.json()).toMatchObject({
      objects: [
        { objectTypeId: "contract", primaryId: "c1" },
        { objectTypeId: "invoice", primaryId: "i1" },
      ],
      links: [
        {
          source: { objectTypeId: "contract", primaryId: "c1" },
          linkId: "invoice",
          target: { objectTypeId: "invoice", primaryId: "i1" },
        },
      ],
    })
  })

  test("disabled auth keeps the object read routes privileged", async () => {
    const { app } = await createApp({ auth: false })

    const response = await app.fetch(new Request("http://localhost/api/objects"))
    const body = (await response.json()) as { objects: { objectTypeId: string }[] }

    expect(response.status).toBe(200)
    expect(new Set(body.objects.map((row) => row.objectTypeId))).toEqual(
      new Set(["contract", "invoice"])
    )

    const latest = await app.fetch(
      new Request("http://localhost/api/objects/invoice/i1/telemetry/score/latest")
    )
    expect(latest.status).toBe(200)
    expect(await latest.json()).toMatchObject({ objectTypeId: "invoice", value: 20 })

    const bulk = await app.fetch(
      new Request("http://localhost/api/telemetry/history", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          series: [{ objectTypeId: "invoice", objectId: "i1", propertyId: "score" }],
        }),
      })
    )
    expect(bulk.status).toBe(200)
    expect(await bulk.json()).toEqual({
      series: [
        {
          objectTypeId: "invoice",
          objectId: "i1",
          propertyId: "score",
          points: [
            expect.objectContaining({
              objectTypeId: "invoice",
              objectId: "i1",
              propertyId: "score",
              value: 20,
            }),
          ],
        },
      ],
    })
  })

  test("dataset routes narrow to viewable datasets and hide forbidden identities", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const operatorList = await app.fetch(
      new Request("http://localhost/api/datasets", { headers: operator.headers })
    )
    const operatorDatasets = (await operatorList.json()) as {
      id: string
      syncIds: string[]
      sourcePipelineIds: string[]
      targetPipelineIds: string[]
      projectionIds: string[]
    }[]
    expect(operatorDatasets.map((dataset) => dataset.id)).toEqual(["raw.erp.orders"])
    expect(operatorDatasets[0]).toEqual(
      expect.objectContaining({
        syncIds: [],
        sourcePipelineIds: [],
        targetPipelineIds: [],
        // The link projection also targets invoices, so it stays hidden without invoice view access.
        projectionIds: ["orders-contracts"],
      })
    )

    const operatorDetail = await app.fetch(
      new Request("http://localhost/api/datasets/raw.erp.orders", { headers: operator.headers })
    )
    expect(operatorDetail.status).toBe(200)
    expect(await operatorDetail.json()).toEqual(
      expect.objectContaining({
        syncIds: [],
        sourcePipelineIds: [],
        targetPipelineIds: [],
        projectionIds: ["orders-contracts"],
      })
    )

    const hiddenList = await app.fetch(
      new Request("http://localhost/api/datasets", { headers: runner.headers })
    )
    expect(await hiddenList.json()).toEqual([])

    const hiddenDetail = await app.fetch(
      new Request("http://localhost/api/datasets/raw.crm.customers", {
        headers: operator.headers,
      })
    )
    expect(hiddenDetail.status).toBe(404)

    const hiddenVersions = await app.fetch(
      new Request("http://localhost/api/datasets/raw.crm.customers/versions", {
        headers: operator.headers,
      })
    )
    expect(hiddenVersions.status).toBe(404)

    const hiddenRows = await app.fetch(
      new Request("http://localhost/api/datasets/raw.crm.customers/rows", {
        headers: operator.headers,
      })
    )
    expect(hiddenRows.status).toBe(404)

    const adminList = await app.fetch(
      new Request("http://localhost/api/datasets", { headers: admin.headers })
    )
    const adminDatasets = (await adminList.json()) as {
      id: string
      syncIds: string[]
      sourcePipelineIds: string[]
      targetPipelineIds: string[]
      projectionIds: string[]
    }[]
    expect(adminDatasets.map((dataset) => dataset.id)).toEqual([
      "raw.erp.orders",
      "raw.crm.customers",
    ])
    const adminDatasetById = new Map(adminDatasets.map((dataset) => [dataset.id, dataset]))
    expect(adminDatasetById.get("raw.erp.orders")).toEqual(
      expect.objectContaining({
        syncIds: ["sync-orders"],
        sourcePipelineIds: ["pipeline-orders"],
        targetPipelineIds: ["pipeline-orders"],
        projectionIds: ["orders-contracts", "orders-contract-invoices"],
      })
    )
    expect(adminDatasetById.get("raw.crm.customers")).toEqual(
      expect.objectContaining({
        syncIds: ["sync-customers"],
        sourcePipelineIds: ["pipeline-customers"],
        targetPipelineIds: ["pipeline-customers"],
        projectionIds: ["customers-invoices"],
      })
    )
  })
})

describe("authorized adjacent read routes", () => {
  test("telemetry reads inherit object visibility", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")

    const history = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/telemetry/temperature/history", {
        headers: operator.headers,
      })
    )
    expect(history.status).toBe(200)
    expect(((await history.json()) as { value: number }[]).map((point) => point.value)).toEqual([
      72.5,
    ])

    const latest = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/telemetry/temperature/latest", {
        headers: operator.headers,
      })
    )
    expect(latest.status).toBe(200)
    expect(await latest.json()).toEqual(expect.objectContaining({ value: 72.5 }))

    const hiddenHistory = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/telemetry/temperature/history", {
        headers: runner.headers,
      })
    )
    expect(hiddenHistory.status).toBe(404)

    const hiddenLatest = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/telemetry/temperature/latest", {
        headers: runner.headers,
      })
    )
    expect(hiddenLatest.status).toBe(404)
  })

  test("rule states narrow to viewable object types before pagination", async () => {
    const { app, storage } = await createApp()
    await seedRuleStates(storage)
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const operatorStates = await app.fetch(
      new Request("http://localhost/api/rule-states?limit=1", { headers: operator.headers })
    )
    expect(await operatorStates.json()).toEqual({
      states: [
        expect.objectContaining({
          ruleId: "contract-review",
          subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
        }),
      ],
      hasMore: false,
      total: 1,
    })

    const hiddenFilter = await app.fetch(
      new Request("http://localhost/api/rule-states?objectTypeId=invoice", {
        headers: operator.headers,
      })
    )
    expect(await hiddenFilter.json()).toEqual({ states: [], hasMore: false, total: 0 })

    const runnerStates = await app.fetch(
      new Request("http://localhost/api/rule-states", { headers: runner.headers })
    )
    expect(await runnerStates.json()).toEqual({ states: [], hasMore: false, total: 0 })

    const adminStates = await app.fetch(
      new Request("http://localhost/api/rule-states", { headers: admin.headers })
    )
    expect(
      (
        (await adminStates.json()) as { states: { subject: { objectTypeId: string } }[] }
      ).states.map((state) => state.subject.objectTypeId)
    ).toEqual(["invoice", "contract"])
  })

  test("projection reads inherit object visibility", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const operatorList = await app.fetch(
      new Request("http://localhost/api/projections", { headers: operator.headers })
    )
    const operatorProjections = (await operatorList.json()) as {
      objectProjections: { id: string }[]
      linkProjections: { id: string }[]
    }
    expect(operatorProjections.objectProjections.map((projection) => projection.id)).toEqual([
      "orders-contracts",
    ])
    expect(operatorProjections.linkProjections.map((projection) => projection.id)).toEqual([])

    const hiddenDetail = await app.fetch(
      new Request("http://localhost/api/projections/customers-invoices", {
        headers: operator.headers,
      })
    )
    expect(hiddenDetail.status).toBe(404)

    const runnerList = await app.fetch(
      new Request("http://localhost/api/projections", { headers: runner.headers })
    )
    expect(await runnerList.json()).toEqual({
      objectProjections: [],
      linkProjections: [],
      telemetryProjections: [],
    })

    const adminList = await app.fetch(
      new Request("http://localhost/api/projections", { headers: admin.headers })
    )
    const adminProjections = (await adminList.json()) as {
      objectProjections: { id: string }[]
      linkProjections: { id: string }[]
    }
    expect(adminProjections.objectProjections.map((projection) => projection.id)).toEqual([
      "orders-contracts",
      "customers-invoices",
    ])
    expect(adminProjections.linkProjections.map((projection) => projection.id)).toEqual([
      "orders-contract-invoices",
    ])
  })
})

describe("authorized catalogs and run requests", () => {
  // `commercial` applies send-contract; `operations` runs the orders sync and pipeline and the
  // workflow; `admins` hold every wildcard grant.
  test.each([
    {
      catalog: "actions",
      granted: "commercial",
      denied: "operations",
      ids: ["send-contract"],
      all: ["send-contract"],
    },
    {
      catalog: "syncs",
      granted: "operations",
      denied: "commercial",
      ids: ["sync-orders"],
      all: ["sync-orders", "sync-customers"],
    },
    {
      catalog: "pipelines",
      granted: "operations",
      denied: "commercial",
      ids: ["pipeline-orders"],
      all: ["pipeline-orders", "pipeline-customers"],
    },
    {
      catalog: "workflows",
      granted: "operations",
      denied: "commercial",
      ids: ["renew-contract"],
      all: ["renew-contract"],
    },
  ])("the $catalog catalog narrows to what the principal may use and hides the rest as 404", async ({
    catalog,
    granted,
    denied,
    ids,
    all,
  }) => {
    const { app, storage } = await createApp()
    const allowed = await seedSession(storage, [granted], "usr_allowed")
    const outsider = await seedSession(storage, [denied], "usr_outsider")
    const admin = await seedSession(storage, ["admins"], "usr_admin")
    const list = async (headers: HeadersInit) => {
      const response = await app.fetch(new Request(`http://localhost/api/${catalog}`, { headers }))
      return ((await response.json()) as { id: string }[]).map((entry) => entry.id)
    }

    expect(await list(allowed.headers)).toEqual([...ids])
    expect(await list(outsider.headers)).toEqual([])
    // Existence-hiding, never 403.
    const hidden = await app.fetch(
      new Request(`http://localhost/api/${catalog}/${ids[0]}`, { headers: outsider.headers })
    )
    expect(hidden.status).toBe(404)
    expect(await list(admin.headers)).toEqual([...all])
  })

  test.each([
    {
      route: "action",
      grant: "can.apply",
      path: "/api/actions/send-contract",
      body: { subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" } },
      granted: "commercial",
      denied: "operations",
      accepted: 200,
    },
    {
      route: "sync run",
      grant: "can.run",
      path: "/api/syncs/sync-orders/runs",
      body: { commitMessage: "manual run" },
      granted: "operations",
      denied: "commercial",
      accepted: 202,
    },
    {
      route: "pipeline run",
      grant: "can.run",
      path: "/api/pipelines/pipeline-orders/runs",
      body: {},
      granted: "operations",
      denied: "commercial",
      accepted: 202,
    },
    {
      route: "workflow run",
      grant: "can.run",
      path: "/api/workflows/renew-contract/runs",
      body: { input: { contract: { objectTypeId: "contract", primaryId: "c1" } } },
      granted: "operations",
      denied: "commercial",
      accepted: 202,
    },
  ])("$route requests require $grant", async ({ path, body, granted, denied, accepted }) => {
    const { app, storage } = await createApp()
    const allowed = await seedSession(storage, [granted], "usr_allowed")
    const outsider = await seedSession(storage, [denied], "usr_outsider")
    const request = (headers: HeadersInit) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      )

    expect((await request(allowed.csrfHeaders)).status).toBe(accepted)
    expect((await request(outsider.csrfHeaders)).status).toBe(403)
  })
})

describe("authorized action routes", () => {
  test("action run history inherits action and subject visibility", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const request = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", {
        method: "POST",
        headers: operator.csrfHeaders,
        body: JSON.stringify({
          subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
        }),
      })
    )
    const requested = (await request.json()) as { id: string }
    await recordTestActionRun(storage, {
      id: "act_hidden_invoice",
      projectId: "test-project",
      actionId: "send-contract",
      subject: { kind: "object", objectTypeId: "invoice", primaryId: "i1" },
      params: {},
      idempotencyKey: "act_hidden_invoice",
      startedAt: new Date("2099-01-01T00:00:00.000Z"),
    })

    const visibleList = await app.fetch(
      new Request("http://localhost/api/action-runs?limit=1", { headers: operator.headers })
    )
    expect(await visibleList.json()).toMatchObject({
      runs: [expect.objectContaining({ id: requested.id })],
      hasMore: false,
      total: 1,
    })

    const hiddenList = await app.fetch(
      new Request("http://localhost/api/action-runs", { headers: runner.headers })
    )
    expect(await hiddenList.json()).toMatchObject({ runs: [], total: 0 })

    const hiddenDetail = await app.fetch(
      new Request(`http://localhost/api/action-runs/${requested.id}`, {
        headers: runner.headers,
      })
    )
    expect(hiddenDetail.status).toBe(404)
  })

  // Reproduce: drop the objectTypeId and primaryId subject from actions.runs.list; c1's runs
  // come back empty.
  test("an object's run history lists through a view condition", async () => {
    const { app, storage, host } = await createApp()
    const reviewer = await seedSession(storage, ["reviewers"], "usr_review")
    await createTestSixb(host).objects.upsert("contract", { id: "c2" })

    for (const primaryId of ["c1", "c2"]) {
      await recordTestActionRun(storage, {
        id: `act_${primaryId}`,
        projectId: "test-project",
        actionId: "send-contract",
        subject: { kind: "object", objectTypeId: "contract", primaryId },
        params: {},
        idempotencyKey: `act_${primaryId}`,
        startedAt: new Date("2099-01-01T00:00:00.000Z"),
      })
    }

    const runsOf = async (primaryId: string) => {
      const response = await app.fetch(
        new Request(
          `http://localhost/api/action-runs?objectTypeId=contract&primaryId=${primaryId}`,
          { headers: reviewer.headers }
        )
      )
      return response.json()
    }

    expect(await runsOf("c1")).toMatchObject({
      runs: [expect.objectContaining({ id: "act_c1" })],
      hasMore: false,
      total: 1,
    })
    expect(await runsOf("c2")).toEqual({ runs: [], hasMore: false, total: 0 })
  })
})

describe("authorized sync routes", () => {
  test("sync run history narrows to runnable syncs", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    await startTestSyncRun(storage, {
      id: "run-orders",
      projectId: "test-project",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
    })
    await startTestSyncRun(storage, {
      id: "run-customers",
      projectId: "test-project",
      syncId: "sync-customers",
      datasetId: "raw.crm.customers",
      mode: "snapshot",
      startedAt: new Date("2026-05-16T13:00:00.000Z"),
    })

    const runnerRuns = await app.fetch(
      new Request("http://localhost/api/sync-runs", { headers: runner.headers })
    )
    expect(((await runnerRuns.json()) as { runs: { syncId: string }[] }).runs).toEqual([
      expect.objectContaining({ syncId: "sync-orders" }),
    ])

    const hiddenRuns = await app.fetch(
      new Request("http://localhost/api/sync-runs?syncId=sync-customers", {
        headers: runner.headers,
      })
    )
    expect(await hiddenRuns.json()).toEqual({ runs: [], hasMore: false, total: 0 })

    const operatorRuns = await app.fetch(
      new Request("http://localhost/api/sync-runs", { headers: operator.headers })
    )
    expect(await operatorRuns.json()).toEqual({ runs: [], hasMore: false, total: 0 })

    const adminRuns = await app.fetch(
      new Request("http://localhost/api/sync-runs", { headers: admin.headers })
    )
    expect(
      ((await adminRuns.json()) as { runs: { syncId: string }[] }).runs.map((run) => run.syncId)
    ).toEqual(["sync-customers", "sync-orders"])
  })
})

describe("authorized pipeline routes", () => {
  test("pipeline run history narrows to runnable pipelines", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    await startTestPipelineRun(storage, {
      id: "run-orders",
      projectId: "test-project",
      pipelineId: "pipeline-orders",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
    })
    await startTestPipelineRun(storage, {
      id: "run-customers",
      projectId: "test-project",
      pipelineId: "pipeline-customers",
      startedAt: new Date("2026-05-16T13:00:00.000Z"),
    })

    const runnerRuns = await app.fetch(
      new Request("http://localhost/api/pipeline-runs", { headers: runner.headers })
    )
    expect(((await runnerRuns.json()) as { runs: { pipelineId: string }[] }).runs).toEqual([
      expect.objectContaining({ pipelineId: "pipeline-orders" }),
    ])

    const hiddenRuns = await app.fetch(
      new Request("http://localhost/api/pipeline-runs?pipelineId=pipeline-customers", {
        headers: runner.headers,
      })
    )
    expect(await hiddenRuns.json()).toEqual({ runs: [], hasMore: false, total: 0 })

    const hiddenDetail = await app.fetch(
      new Request("http://localhost/api/pipeline-runs/run-customers", {
        headers: runner.headers,
      })
    )
    expect(hiddenDetail.status).toBe(404)

    const allowedDetail = await app.fetch(
      new Request("http://localhost/api/pipeline-runs/run-orders", { headers: runner.headers })
    )
    expect(allowedDetail.status).toBe(200)

    const operatorRuns = await app.fetch(
      new Request("http://localhost/api/pipeline-runs", { headers: operator.headers })
    )
    expect(await operatorRuns.json()).toEqual({ runs: [], hasMore: false, total: 0 })

    const adminRuns = await app.fetch(
      new Request("http://localhost/api/pipeline-runs", { headers: admin.headers })
    )
    expect(
      ((await adminRuns.json()) as { runs: { pipelineId: string }[] }).runs.map(
        (run) => run.pipelineId
      )
    ).toEqual(["pipeline-customers", "pipeline-orders"])
  })
})

describe("authorized event and workflow routes", () => {
  test("event reads return only the events the principal may see", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")

    // The operator can view Contract, so contract events are visible.
    const operatorEvents = await app.fetch(
      new Request("http://localhost/api/events", { headers: operator.headers })
    )
    expect(operatorEvents.status).toBe(200)
    const operatorBody = (await operatorEvents.json()) as { events: { type: string }[] }
    expect(operatorBody.events.map((event) => event.type)).toContain("object.created")

    // The runner has no object grants, so object events are filtered out.
    const runnerEvents = await app.fetch(
      new Request("http://localhost/api/events", { headers: runner.headers })
    )
    expect(runnerEvents.status).toBe(200)
    const runnerBody = (await runnerEvents.json()) as { events: { type: string }[] }
    expect(runnerBody.events.filter((event) => event.type === "object.created")).toEqual([])
  })

  test("workflow run history and interventions inherit workflow run visibility", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const request = await app.fetch(
      new Request("http://localhost/api/workflows/renew-contract/runs", {
        method: "POST",
        headers: runner.csrfHeaders,
        body: JSON.stringify({
          input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
        }),
      })
    )
    const requested = (await request.json()) as { runId: string }
    const hiddenExecutionId = await createTestWorkflowExecution(storage.executions, {
      projectId: "test-project",
      workflowId: "hidden-workflow",
      runId: "wf_hidden",
    })
    await storage.workflowRuns.queue({
      id: "wf_hidden",
      projectId: "test-project",
      executionId: hiddenExecutionId,
      workflowId: "hidden-workflow",
      input: {},
      queuedAt: new Date("2099-01-01T00:00:00.000Z"),
    })
    await storage.workflowInterventions.create({
      id: "wi_1",
      projectId: "test-project",
      workflowId: "renew-contract",
      workflowRunId: requested.runId,
      nodeRunId: "node_1",
      nodeIndex: 0,
      nodeId: "approval",
      nodeKey: "approval",
      interventionId: "approval",
      input: {},
      defaultResponse: {},
      requestedAt: new Date("2026-05-16T10:00:00.000Z"),
    })
    await storage.workflowInterventions.create({
      id: "wi_hidden",
      projectId: "test-project",
      workflowId: "hidden-workflow",
      workflowRunId: "wf_hidden",
      nodeRunId: "node_hidden",
      nodeIndex: 0,
      nodeId: "approval",
      nodeKey: "approval",
      interventionId: "approval",
      input: {},
      defaultResponse: {},
      requestedAt: new Date("2099-01-01T00:00:00.000Z"),
    })

    const runnerRuns = await app.fetch(
      new Request("http://localhost/api/workflow-runs?limit=1", { headers: runner.headers })
    )
    expect(await runnerRuns.json()).toMatchObject({
      runs: [
        expect.objectContaining({
          id: requested.runId,
          requestedBy: { type: "user", id: "usr_run" },
        }),
      ],
      hasMore: false,
      total: 1,
    })

    const operatorRuns = await app.fetch(
      new Request("http://localhost/api/workflow-runs", { headers: operator.headers })
    )
    expect(await operatorRuns.json()).toMatchObject({ runs: [], total: 0 })

    const hiddenRun = await app.fetch(
      new Request(`http://localhost/api/workflow-runs/${requested.runId}`, {
        headers: operator.headers,
      })
    )
    expect(hiddenRun.status).toBe(404)

    const runnerInterventions = await app.fetch(
      new Request("http://localhost/api/workflow-interventions?limit=1", {
        headers: runner.headers,
      })
    )
    expect(await runnerInterventions.json()).toMatchObject({
      interventions: [expect.objectContaining({ id: "wi_1" })],
      hasMore: false,
      total: 1,
    })

    const operatorInterventions = await app.fetch(
      new Request("http://localhost/api/workflow-interventions", { headers: operator.headers })
    )
    expect(await operatorInterventions.json()).toMatchObject({ interventions: [], total: 0 })

    const hiddenIntervention = await app.fetch(
      new Request("http://localhost/api/workflow-interventions/wi_1", {
        headers: operator.headers,
      })
    )
    expect(hiddenIntervention.status).toBe(404)
  })
})
