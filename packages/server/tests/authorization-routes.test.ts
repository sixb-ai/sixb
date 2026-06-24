import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import {
  actions,
  can,
  col,
  createSessionCredential,
  datasets,
  defineAction,
  defineConnector,
  defineDataset,
  defineGroup,
  defineLinkProjection,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineProjection,
  defineRole,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  link,
  type OntologySource,
  ontology,
  type PipelineDefinition,
  pipelines,
  prop,
  ref,
  Sixb,
  syncs,
  type WorkflowDefinition,
  workflows,
} from "@sixb/core"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [
    prop("id", "string", { required: true, primary: true }),
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

const ordersContractInvoiceProjection = defineLinkProjection(
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
    can.view(ontology.objects()),
    can.view(datasets()),
    can.apply(actions()),
    can.run(workflows()),
    can.run(syncs()),
    can.run(pipelines()),
  ],
})

async function createRuntime(options: { readonly auth?: boolean } = {}) {
  const storage = new InMemoryStorage()
  const sixb = new Sixb<readonly OntologySource[]>({
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
    groups: [commercial, operations, admins],
    roles: [contractOperator, operationsRunner, adminOperator],
    auth: options.auth === false ? undefined : { id: "test", kind: "dev" as const },
  })

  await sixb.upsertObject("contract", { id: "c1" })
  await sixb.upsertObject("invoice", { id: "i1" })
  await sixb.upsertLink("contract", "c1", "invoice", {
    targetTypeId: "invoice",
    targetId: "i1",
  })
  await sixb.appendTelemetry("contract", [
    {
      id: "c1",
      properties: { temperature: 72.5 },
      at: new Date("2026-05-16T10:30:00.000Z"),
    },
  ])

  return { sixb, storage }
}

async function createApp(options: { readonly auth?: boolean } = {}) {
  const { sixb, storage } = await createRuntime(options)
  const app = createSixbApi(
    new SixbServer({ sixb, quiet: true, browser: createTestBrowserPolicy() })
  )

  return { app, storage }
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
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-05-16T10:00:00.000Z"),
    expiresAt: new Date("2099-05-16T10:00:00.000Z"),
  })

  return {
    headers: { cookie: `sixb_session=${credential.cookieValue}` },
    csrfHeaders: {
      cookie: `sixb_session=${credential.cookieValue}; sixb_csrf=csrf_1`,
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

    const operatorList = await app.fetch(
      new Request("http://localhost/api/object-types", { headers: operator.headers })
    )
    const operatorBody = (await operatorList.json()) as {
      id: string
      actions: { id: string }[]
    }[]

    expect(operatorList.status).toBe(200)
    expect(operatorBody.map((objectType) => objectType.id)).toEqual(["contract"])
    expect(operatorBody[0].actions.map((action) => action.id)).toEqual(["send-contract"])

    const hidden = await app.fetch(
      new Request("http://localhost/api/object-types/invoice", { headers: operator.headers })
    )
    expect(hidden.status).toBe(404)

    const runnerList = await app.fetch(
      new Request("http://localhost/api/object-types", { headers: runner.headers })
    )
    expect(await runnerList.json()).toEqual([])
  })

  test("wildcard object and action grants expose all object metadata", async () => {
    const { app, storage } = await createApp()
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const response = await app.fetch(
      new Request("http://localhost/api/object-types", { headers: admin.headers })
    )
    const body = (await response.json()) as {
      id: string
      actions: { id: string }[]
    }[]

    expect(response.status).toBe(200)
    expect(body.map((objectType) => objectType.id)).toEqual(["contract", "invoice"])
    expect(body.find((objectType) => objectType.id === "contract")?.actions).toEqual([
      expect.objectContaining({ id: "send-contract" }),
    ])
  })

  test("broad listings narrow to the principal's viewable types", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const response = await app.fetch(
      new Request("http://localhost/api/objects", { headers: session.headers })
    )
    const body = (await response.json()) as { objects: { objectTypeId: string }[] }

    expect(response.status).toBe(200)
    expect(body.objects.map((row) => row.objectTypeId)).toEqual(["contract"])
  })

  test("explicitly requesting a forbidden type returns 403", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, ["commercial"])

    const response = await app.fetch(
      new Request("http://localhost/api/objects?objectTypeId=invoice", {
        headers: session.headers,
      })
    )

    expect(response.status).toBe(403)
  })

  test("principals with no grants list nothing", async () => {
    const { app, storage } = await createApp()
    const session = await seedSession(storage, [])

    const response = await app.fetch(
      new Request("http://localhost/api/objects", { headers: session.headers })
    )
    const body = (await response.json()) as { objects: unknown[]; hasMore: boolean; total: number }

    expect(response.status).toBe(200)
    expect(body).toEqual({ objects: [], hasMore: false, total: 0 })
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
  })

  test("disabled auth keeps object routes privileged", async () => {
    const { app } = await createApp({ auth: false })

    const response = await app.fetch(new Request("http://localhost/api/objects"))
    const body = (await response.json()) as { objects: { objectTypeId: string }[] }

    expect(response.status).toBe(200)
    expect(new Set(body.objects.map((row) => row.objectTypeId))).toEqual(
      new Set(["contract", "invoice"])
    )
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
        projectionIds: ["orders-contracts", "orders-contract-invoices"],
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
        projectionIds: ["orders-contracts", "orders-contract-invoices"],
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
  test("link reads inherit source and target object visibility", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const operatorLinks = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/links", {
        headers: operator.headers,
      })
    )
    expect(operatorLinks.status).toBe(200)
    expect(await operatorLinks.json()).toEqual([])

    const hiddenSource = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/links", {
        headers: runner.headers,
      })
    )
    expect(hiddenSource.status).toBe(404)

    const adminLinks = await app.fetch(
      new Request("http://localhost/api/objects/contract/c1/links", {
        headers: admin.headers,
      })
    )
    expect(
      ((await adminLinks.json()) as { targetTypeId: string }[]).map((link) => link.targetTypeId)
    ).toEqual(["invoice"])
  })

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

describe("authorized action routes", () => {
  test("action metadata narrows to applicable actions", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")

    const operatorList = await app.fetch(
      new Request("http://localhost/api/actions", { headers: operator.headers })
    )
    expect(((await operatorList.json()) as { id: string }[]).map((a) => a.id)).toEqual([
      "send-contract",
    ])

    const runnerList = await app.fetch(
      new Request("http://localhost/api/actions", { headers: runner.headers })
    )
    expect(await runnerList.json()).toEqual([])

    const hidden = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", { headers: runner.headers })
    )
    expect(hidden.status).toBe(404)
  })

  test("action requests require can.apply", async () => {
    const { app, storage } = await createApp()
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const body = JSON.stringify({
      subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
    })

    const allowed = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", {
        method: "POST",
        headers: operator.csrfHeaders,
        body,
      })
    )
    // Action requests enqueue asynchronously, so the route returns 202 Accepted.
    expect(allowed.status).toBe(202)

    const denied = await app.fetch(
      new Request("http://localhost/api/actions/send-contract", {
        method: "POST",
        headers: runner.csrfHeaders,
        body,
      })
    )
    expect(denied.status).toBe(403)
  })

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
    const requested = (await request.json()) as { runId: string }
    await storage.actionRuns.queue({
      id: "act_hidden_invoice",
      projectId: "test-project",
      actionId: "send-contract",
      subject: { kind: "object", objectTypeId: "invoice", primaryId: "i1" },
      params: {},
      idempotencyKey: "act_hidden_invoice",
      queuedAt: new Date("2099-01-01T00:00:00.000Z"),
    })

    const visibleList = await app.fetch(
      new Request("http://localhost/api/action-runs?limit=1", { headers: operator.headers })
    )
    expect(await visibleList.json()).toMatchObject({
      runs: [expect.objectContaining({ id: requested.runId })],
      hasMore: false,
      total: 1,
    })

    const hiddenList = await app.fetch(
      new Request("http://localhost/api/action-runs", { headers: runner.headers })
    )
    expect(await hiddenList.json()).toMatchObject({ runs: [], total: 0 })

    const hiddenDetail = await app.fetch(
      new Request(`http://localhost/api/action-runs/${requested.runId}`, {
        headers: runner.headers,
      })
    )
    expect(hiddenDetail.status).toBe(404)
  })
})

describe("authorized sync routes", () => {
  test("sync catalog narrows to runnable syncs and hides the rest as 404", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const runnerList = await app.fetch(
      new Request("http://localhost/api/syncs", { headers: runner.headers })
    )
    expect(((await runnerList.json()) as { id: string }[]).map((sync) => sync.id)).toEqual([
      "sync-orders",
    ])

    const operatorList = await app.fetch(
      new Request("http://localhost/api/syncs", { headers: operator.headers })
    )
    expect(await operatorList.json()).toEqual([])

    const hidden = await app.fetch(
      new Request("http://localhost/api/syncs/sync-orders", { headers: operator.headers })
    )
    expect(hidden.status).toBe(404)

    const adminList = await app.fetch(
      new Request("http://localhost/api/syncs", { headers: admin.headers })
    )
    expect(((await adminList.json()) as { id: string }[]).map((sync) => sync.id)).toEqual([
      "sync-orders",
      "sync-customers",
    ])
  })

  test("sync run requests require can.run", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")

    const allowed = await app.fetch(
      new Request("http://localhost/api/syncs/sync-orders/runs", {
        method: "POST",
        headers: runner.csrfHeaders,
        body: JSON.stringify({ commitMessage: "manual run" }),
      })
    )
    expect(allowed.status).toBe(202)

    const denied = await app.fetch(
      new Request("http://localhost/api/syncs/sync-orders/runs", {
        method: "POST",
        headers: operator.csrfHeaders,
        body: JSON.stringify({ commitMessage: "manual run" }),
      })
    )
    expect(denied.status).toBe(403)
  })

  test("sync run history narrows to runnable syncs", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    await storage.syncRuns!.start({
      id: "run-orders",
      projectId: "test-project",
      syncId: "sync-orders",
      datasetId: "raw.erp.orders",
      mode: "snapshot",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
    })
    await storage.syncRuns!.start({
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
  test("pipeline catalog narrows to runnable pipelines and hides the rest as 404", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    const runnerList = await app.fetch(
      new Request("http://localhost/api/pipelines", { headers: runner.headers })
    )
    expect(((await runnerList.json()) as { id: string }[]).map((pipeline) => pipeline.id)).toEqual([
      "pipeline-orders",
    ])

    const operatorList = await app.fetch(
      new Request("http://localhost/api/pipelines", { headers: operator.headers })
    )
    expect(await operatorList.json()).toEqual([])

    const hidden = await app.fetch(
      new Request("http://localhost/api/pipelines/pipeline-orders", { headers: operator.headers })
    )
    expect(hidden.status).toBe(404)

    const adminList = await app.fetch(
      new Request("http://localhost/api/pipelines", { headers: admin.headers })
    )
    expect(((await adminList.json()) as { id: string }[]).map((pipeline) => pipeline.id)).toEqual([
      "pipeline-orders",
      "pipeline-customers",
    ])
  })

  test("pipeline run requests require can.run", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")

    const allowed = await app.fetch(
      new Request("http://localhost/api/pipelines/pipeline-orders/runs", {
        method: "POST",
        headers: runner.csrfHeaders,
        body: JSON.stringify({}),
      })
    )
    expect(allowed.status).toBe(202)

    const denied = await app.fetch(
      new Request("http://localhost/api/pipelines/pipeline-orders/runs", {
        method: "POST",
        headers: operator.csrfHeaders,
        body: JSON.stringify({}),
      })
    )
    expect(denied.status).toBe(403)
  })

  test("pipeline run history narrows to runnable pipelines", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const admin = await seedSession(storage, ["admins"], "usr_admin")

    await storage.pipelineRuns!.start({
      id: "run-orders",
      projectId: "test-project",
      pipelineId: "pipeline-orders",
      startedAt: new Date("2026-05-16T12:00:00.000Z"),
    })
    await storage.pipelineRuns!.start({
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
    expect(operatorBody.events.map((event) => event.type)).toContain("object.upserted")

    // The runner has no object grants, so object events are filtered out.
    const runnerEvents = await app.fetch(
      new Request("http://localhost/api/events", { headers: runner.headers })
    )
    expect(runnerEvents.status).toBe(200)
    const runnerBody = (await runnerEvents.json()) as { events: { type: string }[] }
    expect(runnerBody.events.filter((event) => event.type === "object.upserted")).toEqual([])
  })

  test("workflow catalog narrows to runnable workflows and hides the rest as 404", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")

    // The runner can run renew-contract, so it appears in the catalog.
    const runnerList = await app.fetch(
      new Request("http://localhost/api/workflows", { headers: runner.headers })
    )
    expect(((await runnerList.json()) as { id: string }[]).map((w) => w.id)).toEqual([
      "renew-contract",
    ])

    // The operator holds no run grant, so the catalog is empty and the detail
    // route hides the workflow as 404 (existence-hiding, never 403).
    const operatorList = await app.fetch(
      new Request("http://localhost/api/workflows", { headers: operator.headers })
    )
    expect(await operatorList.json()).toEqual([])

    const hidden = await app.fetch(
      new Request("http://localhost/api/workflows/renew-contract", { headers: operator.headers })
    )
    expect(hidden.status).toBe(404)
  })

  test("workflow runs require can.run", async () => {
    const { app, storage } = await createApp()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const body = JSON.stringify({
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    })

    const allowed = await app.fetch(
      new Request("http://localhost/api/workflows/renew-contract/runs", {
        method: "POST",
        headers: runner.csrfHeaders,
        body,
      })
    )
    expect(allowed.status).toBe(202)

    const denied = await app.fetch(
      new Request("http://localhost/api/workflows/renew-contract/runs", {
        method: "POST",
        headers: operator.csrfHeaders,
        body,
      })
    )
    expect(denied.status).toBe(403)
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
    await storage.workflowRuns.queue({
      id: "wf_hidden",
      projectId: "test-project",
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
      runs: [expect.objectContaining({ id: requested.runId })],
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

describe("authorized event websocket", () => {
  test("any authenticated principal may connect; events are filtered as they stream", async () => {
    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const { sixb, storage } = await createRuntime()
    const runner = await seedSession(storage, ["operations"], "usr_run")
    const operator = await seedSession(storage, ["commercial"], "usr_op")
    const server = new SixbServer({
      sixb,
      host: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: baseUrl, atlasOrigin: baseUrl }),
    })

    await server.start()
    try {
      const wsUrl = `${baseUrl.replace("http://", "ws://")}/ws/events`

      // No connection-level events grant: both principals connect, and the
      // stream is filtered per-event by their grants during polling.
      const runnerWs = new WebSocket(wsUrl, { headers: runner.headers })
      expect(await nextWsMessage(runnerWs)).toEqual({ type: "connected", channel: "events" })
      runnerWs.close()

      const operatorWs = new WebSocket(wsUrl, { headers: operator.headers })
      expect(await nextWsMessage(operatorWs)).toEqual({ type: "connected", channel: "events" })
      operatorWs.close()
    } finally {
      await server.stop()
    }
  })
})

function nextWsMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String((event as MessageEvent).data))),
      { once: true }
    )
    ws.addEventListener("error", () => reject(new Error("WebSocket errored")), { once: true })
    ws.addEventListener("close", () => reject(new Error("WebSocket closed before a message")), {
      once: true,
    })
  })
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(port)
      })
    })
  })
}
