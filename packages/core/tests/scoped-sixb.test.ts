import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  type AuthorizationContext,
  AuthorizationError,
  can,
  col,
  defineAction,
  defineAgent,
  defineAgentStep,
  defineConnector,
  defineDataset,
  defineGroup,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRole,
  defineSync,
  defineWorkflow,
  defineWorkflowStep,
  link,
  type PipelineDefinition,
  prop,
  ref,
  resolveAuthorizationContext,
  type SecurityDefinitionCatalog,
  SixbHost,
  type Storage,
  type StoredDomainEvent,
  type WorkflowDefinition,
} from "../src"
import { agentServiceAccountId, ensureAgentExecutionIdentity } from "../src/agents/authority"
import { createAgentScope } from "../src/execution/scopes"
import type { AuthStorage } from "../src/storage"
import { createTestSixb, type TestExecutionHost } from "../src/testing"
import { createTestRuntimeDeps, waitFor } from "./test-runtime-deps"

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    // A real telemetry property: an append with an empty `properties` produces no points at all, so
    // the append tests below would pass without asserting anything.
    prop("temperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
  ],
})

const SignedContract = defineObjectType({
  id: "signed-contract",
  name: "Signed Contract",
  extends: Contract,
  properties: [prop("countersigned", "boolean")],
})

const Invoice = defineObjectType({
  id: "invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
  links: [link("contract", Contract)],
})

const ContractsDataset = defineDataset("raw.contracts", {
  schema: [col("id", "string")],
})

const InvoicesDataset = defineDataset("raw.invoices", {
  schema: [col("id", "string")],
})

const sourceConnector = defineConnector("source", {
  type: "test",
  async connect() {
    return {}
  },
})

const syncContracts = defineSync("sync-contracts")
  .from(sourceConnector)
  .read(() => [])
  .intoDataset(ContractsDataset)

const syncInvoices = defineSync("sync-invoices")
  .from(sourceConnector)
  .read(() => [])
  .intoDataset(InvoicesDataset)

const contractPipelineStep = definePipelineStep("contract-pipeline-step")
  .inputs({ contracts: ContractsDataset })
  .output(ContractsDataset)
  .run(async () => {})

const invoicePipelineStep = definePipelineStep("invoice-pipeline-step")
  .inputs({ invoices: InvoicesDataset })
  .output(InvoicesDataset)
  .run(async () => {})

const contractPipeline: PipelineDefinition =
  definePipeline("contract-pipeline").then(contractPipelineStep)
const invoicePipeline: PipelineDefinition =
  definePipeline("invoice-pipeline").then(invoicePipelineStep)

const model = {} as Parameters<typeof defineAgent>[1]["model"]

const contractAgent = defineAgent("contract-agent", {
  name: "Contract Agent",
  model,
  instructions: "Help with contracts.",
})

const invoiceAgent = defineAgent("invoice-agent", {
  name: "Invoice Agent",
  model,
  instructions: "Help with invoices.",
})

const reviewContractWithAgent = defineAgentStep("review-contract-with-agent", contractAgent)
  .input({ contract: ref(Contract) })
  .output({ approved: "boolean", reason: "string" })
  .prompt(({ input }) => `Review contract '${input.contract.primaryId}'.`)

// Widened to the base type, like renewContract below: keeps the registered
// actions array out of the deep SixbHost<tuple> instantiation (TS2589).
const sendContract: ActionDefinition = defineAction("send-contract")
  .on(Contract)
  .params({})
  .edits(() => {})

const archiveInvoice: ActionDefinition = defineAction("archive-invoice")
  .on(Invoice)
  .params({})
  .edits(() => {})

const reviewContract = defineWorkflowStep("review-contract")
  .input({ contract: ref(Contract) })
  .output({ contract: ref(Contract) })
  .run(async () => ({ contract: { objectTypeId: "contract", primaryId: "c1" } }))

// Widened to the base type: only used for registration and grants, so the
// registered workflow array avoids instantiating the deep chain type.
const renewContract: WorkflowDefinition = defineWorkflow("renew-contract")
  .input({ contract: ref(Contract) })
  .then(reviewContract)
const agentReviewContract: WorkflowDefinition = defineWorkflow("agent-review-contract")
  .input({ contract: ref(Contract) })
  .then(reviewContractWithAgent)

const commercial = defineGroup("commercial")
const finance = defineGroup("finance")
const ops = defineGroup("ops")
const operations = defineGroup("operations")
const workflowOnly = defineGroup("workflow-only")
const editors = defineGroup("editors")
const blindWriters = defineGroup("blind-writers")
const ingest = defineGroup("ingest")
const linkers = defineGroup("linkers")
const blindLinkers = defineGroup("blind-linkers")

const contractOperator = defineRole("contract.operator", {
  grantedTo: [commercial],
  grants: [can.view(Contract), can.view(ContractsDataset), can.apply(sendContract)],
})

const invoiceViewer = defineRole("invoice.viewer", {
  grantedTo: [finance],
  grants: [can.view(Invoice)],
})

// Apply without view — object actions must require both grants.
const contractSender = defineRole("contract.sender", {
  grantedTo: [ops],
  grants: [can.apply(sendContract)],
})

const operationsRunner = defineRole("operations.runner", {
  grantedTo: [operations],
  grants: [
    can.run(renewContract),
    can.run(agentReviewContract),
    can.run(syncContracts),
    can.run(contractPipeline),
    can.run(contractAgent),
  ],
})

const workflowOnlyRunner = defineRole("workflow-only.runner", {
  grantedTo: [workflowOnly],
  grants: [can.run(agentReviewContract)],
})

const contractEditor = defineRole("contract.editor", {
  grantedTo: [editors],
  grants: [can.view(Contract), can.edit(Contract)],
})

// Edit without view: an upsert answers with the merged row, so this must not be enough.
const blindContractWriter = defineRole("contract.blind-writer", {
  grantedTo: [blindWriters],
  grants: [can.edit(Contract)],
})

// Append with neither view nor edit — the write-only ingest principal.
const contractIngestor = defineRole("contract.ingestor", {
  grantedTo: [ingest],
  grants: [can.append(Contract)],
})

// Writing a link needs edit on the source and view on the target.
const invoiceLinker = defineRole("invoice.linker", {
  grantedTo: [linkers],
  grants: [can.view(Invoice), can.edit(Invoice), can.view(Contract)],
})

const blindInvoiceLinker = defineRole("invoice.blind-linker", {
  grantedTo: [blindLinkers],
  grants: [can.view(Invoice), can.edit(Invoice)],
})

const principal = { type: "user", id: "adam" } as const

// No explicit instance annotations anywhere in this file: naming
// SixbHost<three-type tuple> in a type position (alias, param, ReturnType) trips
// TS2589 instantiation depth. Inference handles it fine.
function createRuntime() {
  return new SixbHost<readonly [typeof Contract, typeof SignedContract, typeof Invoice]>({
    ontology: [Contract, SignedContract, Invoice],
    datasets: [ContractsDataset, InvoicesDataset],
    actions: [sendContract, archiveInvoice],
    connectors: [sourceConnector],
    syncs: [syncContracts, syncInvoices],
    pipelines: [contractPipeline, invoicePipeline],
    workflows: [renewContract, agentReviewContract],
    agents: [contractAgent, invoiceAgent],
    groups: [
      commercial,
      finance,
      ops,
      operations,
      workflowOnly,
      editors,
      blindWriters,
      ingest,
      linkers,
      blindLinkers,
    ],
    roles: [
      contractOperator,
      invoiceViewer,
      contractSender,
      operationsRunner,
      workflowOnlyRunner,
      contractEditor,
      blindContractWriter,
      contractIngestor,
      invoiceLinker,
      blindInvoiceLinker,
    ],
    ...createTestRuntimeDeps(),
  })
}

function bindPrincipal(host: TestExecutionHost, authorization: AuthorizationContext) {
  return createTestSixb(host, { authorization })
}

function contextFor(
  host: { definitions: { security: SecurityDefinitionCatalog } },
  groupIds: readonly string[]
) {
  return resolveAuthorizationContext({
    principal,
    groupIds,
    roles: host.definitions.security.listResolvedRoles(),
  })
}

async function seedPrincipal(
  host: TestExecutionHost & { readonly storage: Pick<Storage, "auth"> }
): Promise<void> {
  const auth = host.storage.auth
  if (!auth) throw new Error("Test runtime requires auth storage.")
  await auth.users.create({
    projectId: host.id,
    id: principal.id,
    email: "adam@example.com",
  })
}

async function seedRequesterMemberships(
  host: { readonly id: string; readonly storage: { readonly auth?: AuthStorage } },
  groupIds: readonly string[]
): Promise<void> {
  const auth = host.storage.auth
  if (!auth) throw new Error("Test requires auth storage")
  for (const groupId of groupIds) {
    await auth.groupMemberships.upsert({
      projectId: host.id,
      userId: principal.id,
      groupId,
      source: "manual",
    })
  }
}

describe("bound Sixb object reads", () => {
  test("granted types support get, list, byId.get, and query", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(await scoped.objects(Contract).get("c1")).toMatchObject({ primaryId: "c1" })
    expect((await scoped.objects(Contract).list()).objects).toHaveLength(1)
    expect(await scoped.objects(Contract).byId("c1").get()).toMatchObject({ primaryId: "c1" })
    expect((await scoped.objects(Contract).query().list()).objects).toHaveLength(1)
  })

  test("view grants include subtypes", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect((await scoped.objects(SignedContract).list()).objects).toEqual([])
  })

  test("ungranted types deny get, list, and query", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(scoped.objects(Invoice).list()).rejects.toThrow(AuthorizationError)
    expect(scoped.objects(Invoice).get("i1")).rejects.toThrow(AuthorizationError)
    expect(scoped.objects(Invoice).byId("i1").get()).rejects.toThrow(AuthorizationError)
    expect(scoped.objects(Invoice).query().list()).rejects.toThrow(AuthorizationError)
  })

  test("queries require every touched type, not just the result type", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    // Starts at Invoice and ends at viewable Contract — still requires can.view(Invoice).
    const query = scoped.objects(Invoice).query()

    expect(query.list()).rejects.toThrow(AuthorizationError)
  })
})

describe("bound Sixb cross-type list", () => {
  async function createSeededRuntime() {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    return { host, sixb }
  }

  test("broad listings narrow to viewable types", async () => {
    const { host } = await createSeededRuntime()
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    const result = await scoped.objects.list({})

    expect(result.objects.map((row) => row.objectTypeId)).toEqual(["contract"])
  })

  test("explicitly requesting a forbidden type fails", async () => {
    const { host } = await createSeededRuntime()
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(scoped.objects.list({ objectTypeIds: ["invoice"] })).rejects.toThrow(AuthorizationError)
    expect(
      (await scoped.objects.list({ objectTypeIds: ["contract"] })).objects.map(
        (row) => row.primaryId
      )
    ).toEqual(["c1"])
  })

  test("principals with no grants list nothing", async () => {
    const { host } = await createSeededRuntime()
    const scoped = bindPrincipal(host, contextFor(host, []))

    expect(await scoped.objects.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
  })
})

describe("bound Sixb actions", () => {
  test("object actions require apply and view together", async () => {
    const host = createRuntime()
    await seedPrincipal(host)
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    const { runId } = await operator
      .objects(Contract)
      .requestAction({ id: "c1", actionId: "send-contract" })
    expect(runId).toBeString()

    // view without apply
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const viewerOnly = createTestSixb(host, {
      authorization: contextFor(host, ["finance"]),
      executionId: "exec_denied_action",
      requestId: "request_denied_action",
      correlationId: "correlation_denied_action",
    })
    expect(
      viewerOnly.objects(Invoice).requestAction({
        id: "i1",
        actionId: "archive-invoice",
        runId: "act_denied_action",
      })
    ).rejects.toThrow(AuthorizationError)
    expect(
      await host.storage.actionRuns?.getById({ projectId: host.id, id: "act_denied_action" })
    ).toBeNull()
    expect(
      await host.storage.executions.getById({ projectId: host.id, id: "exec_denied_action" })
    ).toBeNull()

    // apply without view
    const senderOnly = bindPrincipal(host, contextFor(host, ["ops"]))
    expect(senderOnly.actions.list()).toEqual([])
    expect(senderOnly.actions.getById("send-contract")).toBeNull()
    expect(
      senderOnly.objects(Contract).requestAction({ id: "c1", actionId: "send-contract" })
    ).rejects.toThrow(AuthorizationError)
  })
})

describe("bound Sixb operational access", () => {
  test("dataset catalog narrows to viewable datasets", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(operator.datasets.list().map((dataset) => dataset.id)).toEqual(["raw.contracts"])
    expect(operator.datasets.getById("raw.contracts")?.id).toBe("raw.contracts")
    expect(operator.datasets.getById("raw.invoices")).toBeNull()

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(runner.datasets.list()).toEqual([])
  })

  test("workflow runs require can.run and snapshot all durable requester groups", async () => {
    const host = createRuntime()
    await seedPrincipal(host)
    const sixb = createTestSixb(host)
    await seedRequesterMemberships(host, ["operations", "commercial"])
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const input = {
      workflowId: "renew-contract",
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    }

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    const result = await runner.workflows.requestById(input)
    expect(result.runId).toBeString()
    const run = await host.storage.workflowRuns?.getById({
      projectId: host.id,
      id: result.runId,
    })
    expect(run).toBeDefined()
    await expect(
      host.storage.executions.getById({ projectId: host.id, id: run?.executionId ?? "" })
    ).resolves.toMatchObject({ requestedBy: principal })
    // The authorization context carries only "operations". Attribution resolves the complete
    // durable membership set so a token-scoped caller cannot avoid the commercial group quota.
    expect(run?.requesterGroupIds).toEqual(["commercial", "operations"])
    await expect(runner.workflows.runs.listNodes(result.runId)).resolves.toMatchObject({
      nodes: [],
      total: 0,
    })

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    await expect(operator.workflows.runs.listNodes(result.runId)).resolves.toBeNull()
    expect(operator.workflows.requestById(input)).rejects.toThrow(AuthorizationError)
  })

  test("event visibility is derived from grants", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    // The operator can view Contract, so it sees the object's event.
    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    const visibleEvents = await waitFor(
      () => operator.events.read(),
      (published) => published.some((event) => event.type === "object.created")
    )
    expect(visibleEvents.map((event) => event.type)).toContain("object.created")

    // The runner can run workflows but cannot view Contract, so the contract
    // event is filtered out (no workflow has run, so it sees nothing here).
    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect((await runner.events.read()).filter((event) => event.type === "object.created")).toEqual(
      []
    )
  })

  test("principal executions cannot author domain events", () => {
    const host = createRuntime()
    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(() => operator.events.append({ events: [] })).toThrow(AuthorizationError)
    expect(() => operator.events.emit({ events: [] }, { source: "test" })).toThrow(
      AuthorizationError
    )
  })

  test("action metadata narrows to applicable actions", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(operator.actions.list().map((action) => action.id)).toEqual(["send-contract"])
    expect(operator.actions.getById("send-contract")?.id).toBe("send-contract")
    expect(operator.actions.getById("archive-invoice")).toBeNull()

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(runner.actions.list()).toEqual([])
  })

  test("dynamic action requests enforce apply and view", async () => {
    const host = createRuntime()
    await seedPrincipal(host)
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    const { runId } = await operator.actions.request({
      actionId: "send-contract",
      subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
    })
    expect(runId).toBeString()

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(
      runner.actions.request({
        actionId: "send-contract",
        subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
      })
    ).rejects.toThrow(AuthorizationError)
  })

  test("requestActionAndWait enforces the same grant as requestAction", async () => {
    // It requests through `requestAction` and then only reads the run it just created, so the flat
    // verb is safe to expose — but the assertion has to be pinned, not assumed from the call chain.
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    await expect(
      runner.actions.requestAndWait({
        actionId: "send-contract",
        subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
      })
    ).rejects.toThrow(AuthorizationError)
  })

  test("workflow catalog narrows to runnable workflows", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(runner.workflows.list().map((workflow) => workflow.id)).toEqual([
      "renew-contract",
      "agent-review-contract",
    ])
    expect(runner.workflows.getById("renew-contract")?.id).toBe("renew-contract")

    // No run grant: the workflow is hidden from both listing and lookup.
    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(operator.workflows.list()).toEqual([])
    expect(operator.workflows.getById("renew-contract")).toBeNull()
  })

  test("workflow permission encapsulates agent nodes", async () => {
    const host = createRuntime()
    await seedPrincipal(host)
    const _sixb = createTestSixb(host)
    const workflowOnlyPrincipal = bindPrincipal(host, contextFor(host, ["workflow-only"]))

    expect(workflowOnlyPrincipal.workflows.list().map((workflow) => workflow.id)).toEqual([
      "agent-review-contract",
    ])
    expect(workflowOnlyPrincipal.workflows.getById("agent-review-contract")?.id).toBe(
      "agent-review-contract"
    )

    const { runId } = await workflowOnlyPrincipal.workflows.requestById({
      workflowId: "agent-review-contract",
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    })
    expect(runId).toBeString()

    // A workflow grant authorizes the composite workflow, not direct access
    // to the agents used by its implementation.
    expect(workflowOnlyPrincipal.agents.list()).toEqual([])
    expect(workflowOnlyPrincipal.agents.getById("contract-agent")).toBeNull()
    expect(
      workflowOnlyPrincipal.agents.runs.request({
        agentId: "contract-agent",
        text: "Review this contract.",
      })
    ).rejects.toThrow(AuthorizationError)
  })

  test("sync catalog narrows to runnable syncs", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(runner.syncs.list().map((sync) => sync.id)).toEqual(["sync-contracts"])
    expect(runner.syncs.getById("sync-contracts")?.id).toBe("sync-contracts")
    expect(runner.syncs.getById("sync-invoices")).toBeNull()

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(operator.syncs.list()).toEqual([])
    expect(operator.syncs.getById("sync-contracts")).toBeNull()
  })

  test("a listable sync or pipeline can actually be started, and only with can.run", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const runner = bindPrincipal(host, contextFor(host, ["operations"]))

    // Before `request*`, `listSyncs()` advertised runnable syncs the caller had no way to start.
    const sync = await runner.syncs.request({ syncId: "sync-contracts" })
    expect(sync.syncId).toBe("sync-contracts")
    expect(sync.runId).toStartWith("run_")

    const pipeline = await runner.pipelines.request({ pipelineId: "contract-pipeline" })
    expect(pipeline.pipelineId).toBe("contract-pipeline")
    expect(pipeline.runId).toStartWith("run_")

    // An existing definition the principal may not run is forbidden, not missing.
    expect(runner.syncs.request({ syncId: "sync-invoices" })).rejects.toThrow(AuthorizationError)
    expect(runner.pipelines.request({ pipelineId: "invoice-pipeline" })).rejects.toThrow(
      AuthorizationError
    )
  })

  test("pipeline catalog narrows to runnable pipelines", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(runner.pipelines.list().map((pipeline) => pipeline.id)).toEqual(["contract-pipeline"])
    expect(runner.pipelines.getById("contract-pipeline")?.id).toBe("contract-pipeline")
    expect(runner.pipelines.getById("invoice-pipeline")).toBeNull()

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(operator.pipelines.list()).toEqual([])
    expect(operator.pipelines.getById("contract-pipeline")).toBeNull()
  })

  test("agent catalog narrows to runnable agents", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    expect(runner.agents.list().map((agent) => agent.id)).toEqual(["contract-agent"])
    expect(runner.agents.getById("contract-agent")?.id).toBe("contract-agent")
    expect(runner.agents.getById("invoice-agent")).toBeNull()

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(operator.agents.list()).toEqual([])
    expect(operator.agents.getById("contract-agent")).toBeNull()
  })

  test("agent run requests require can.run and retain the admission snapshot", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    await seedPrincipal(host)
    await seedRequesterMemberships(host, ["operations", "commercial"])

    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    const result = await runner.agents.runs.request({
      agentId: "contract-agent",
      text: "Summarize this account.",
    })
    expect(result.run.id).toBeString()
    expect(result.run.requesterGroupIds).toEqual(["commercial", "operations"])
    expect(result.run.usage).toBeUndefined()
    await expect(
      host.storage.executions.getById({ projectId: host.id, id: result.run.executionId })
    ).resolves.toMatchObject({ requestedBy: principal })

    await host.storage.aiUsage?.recordModelCall({
      id: "usage_contract_agent",
      projectId: host.id,
      executionId: result.run.executionId,
      attempt: 1,
      callId: "call_contract_agent",
      requesterGroupIds: result.run.requesterGroupIds,
      providerId: "gateway",
      requestedModelId: "openai/gpt-5",
      responseId: "response_contract_agent",
      usage: { inputTokens: 12, outputTokens: 3 },
      occurredAt: new Date("2026-07-01T12:00:00.000Z"),
    })
    await expect(runner.agents.runs.getById(result.run.id)).resolves.toMatchObject({
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
        reportingStatus: "complete",
      },
    })

    await host.storage.auth?.groupMemberships.remove({
      projectId: host.id,
      userId: principal.id,
      groupId: "commercial",
    })
    const stored = await host.storage.agents?.runs.getById({
      projectId: host.id,
      id: result.run.id,
    })
    expect(stored?.requesterGroupIds).toEqual(["commercial", "operations"])
    expect(stored).not.toHaveProperty("usage")

    const operator = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(
      operator.agents.runs.request({
        agentId: "contract-agent",
        text: "Summarize this account.",
      })
    ).rejects.toThrow(AuthorizationError)
  })

  test("agent run admission never reactivates a suspended managed identity", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const runner = bindPrincipal(host, contextFor(host, ["operations"]))
    const agent = host.definitions.agents.getById("contract-agent")
    const auth = host.storage.auth
    if (!agent || !auth) throw new Error("Expected Agent definition and auth storage.")

    await ensureAgentExecutionIdentity({ auth, projectId: host.id, agent })
    await auth.serviceAccounts.update({
      projectId: host.id,
      id: agentServiceAccountId(agent.id),
      status: "suspended",
    })
    const thread = await runner.agents.threads.create({ agentId: agent.id })

    await expect(
      runner.agents.runs.request({
        agentId: agent.id,
        threadId: thread.id,
        text: "This must not run.",
      })
    ).rejects.toThrow("is suspended")
    await expect(host.storage.agents?.runs.list({ projectId: host.id })).resolves.toMatchObject({
      runs: [],
      total: 0,
    })
  })

  test("agent threads require both the run grant and ownership", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const ownerContext = contextFor(host, ["operations"])
    const owner = bindPrincipal(host, ownerContext)
    const thread = await owner.agents.threads.create({ agentId: "contract-agent" })

    expect(await owner.agents.threads.getById(thread.id)).toEqual(thread)
    expect((await owner.agents.threads.list()).threads).toEqual([thread])

    const other = bindPrincipal(host, {
      ...ownerContext,
      principal: { type: "user", id: "other-user" },
    })
    expect(await other.agents.threads.getById(thread.id)).toBeNull()
    expect((await other.agents.threads.list()).threads).toEqual([])
    await expect(
      other.agents.runs.request({
        agentId: "contract-agent",
        threadId: thread.id,
        text: "Read another user's thread.",
      })
    ).rejects.toMatchObject({ code: "thread_not_found" })
  })
})

describe("bound Sixb object writes", () => {
  test("a viewer cannot write: view alone grants no edit", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(scoped.objects(Contract).upsert({ properties: { id: "c2" } })).rejects.toThrow(
      AuthorizationError
    )
    expect(scoped.objects.upsert("contract", { id: "c2" })).rejects.toThrow(AuthorizationError)
  })

  test("view plus edit writes, and the write is readable back", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["editors"]))

    await scoped.objects(Contract).upsert({ properties: { id: "c1" } })
    expect(await scoped.objects(Contract).byId("c1").get()).not.toBeNull()
  })

  test("edit without view is refused — an upsert answers with the merged row", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["blind-writers"]))

    expect(scoped.objects(Contract).upsert({ properties: { id: "c2" } })).rejects.toThrow(
      AuthorizationError
    )
  })

  test("delete and restore ride on the same edit grant", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const viewer = bindPrincipal(host, contextFor(host, ["commercial"]))
    expect(viewer.objects(Contract).byId("c1").delete()).rejects.toThrow(AuthorizationError)

    const editor = bindPrincipal(host, contextFor(host, ["editors"]))
    await editor.objects(Contract).byId("c1").delete()
    expect(await editor.objects(Contract).byId("c1").get()).toBeNull()
    await editor.objects(Contract).byId("c1").restore()
  })

  test("ungranted types stay unwritable for a principal that can edit another type", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["editors"]))

    expect(scoped.objects.upsert("invoice", { id: "i1" })).rejects.toThrow(AuthorizationError)
  })

  test("edit does not expand to subtypes", async () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["editors"]))

    // `can.view(Contract)` covers `signed-contract` (view expands); `can.edit(Contract)` must not.
    expect(await scoped.objects(SignedContract).byId("s1").get()).toBeNull()
    expect(scoped.objects.upsert("signed-contract", { id: "s1" })).rejects.toThrow(
      AuthorizationError
    )
  })
})

describe("bound Sixb link writes", () => {
  test("edit on the source and view on the target links", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["linkers"]))

    await scoped.objects(Invoice).upsertLink({
      sourceId: "i1",
      linkId: "contract",
      targetTypeId: "contract",
      targetId: "c1",
    })
    await scoped.objects(Invoice).removeLink({
      sourceId: "i1",
      linkId: "contract",
      targetTypeId: "contract",
      targetId: "c1",
    })
  })

  test("edit on the source is not enough without view on the target", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["blind-linkers"]))

    expect(
      scoped.objects(Invoice).upsertLink({
        sourceId: "i1",
        linkId: "contract",
        targetTypeId: "contract",
        targetId: "c1",
      })
    ).rejects.toThrow(AuthorizationError)
  })

  test("a refused item denies the whole link batch, before anything commits", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["blind-linkers"]))

    expect(
      scoped.objects.upsertLinkBatch([
        {
          objectTypeId: "invoice",
          sourceId: "i1",
          linkId: "contract",
          target: { targetTypeId: "contract", targetId: "c1" },
        },
      ])
    ).rejects.toThrow(AuthorizationError)

    expect(await sixb.objects(Invoice).byId("i1").listLinks()).toHaveLength(0)
  })
})

describe("bound Sixb telemetry appends", () => {
  test("append needs its own grant: an editor cannot append", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["editors"]))

    expect(
      scoped.objects.appendTelemetry("contract", [
        {
          id: "c1",
          properties: { temperature: { value: 21, unit: "degreeCelsius" } },
          at: new Date(),
        },
      ])
    ).rejects.toThrow(AuthorizationError)
  })

  test("append works without view — the write-only ingest principal", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = bindPrincipal(host, contextFor(host, ["ingest"]))

    await scoped.objects.appendTelemetry("contract", [
      {
        id: "c1",
        properties: { temperature: { value: 21, unit: "degreeCelsius" } },
        at: new Date(),
      },
    ])

    // Read back through the privileged runtime: this principal holds no view grant, which is the
    // whole point of the append/edit split.
    const stored = await host.storage.timeseries.getHistory({
      projectId: host.id,
      objectTypeId: "contract",
      objectId: "c1",
      propertyId: "temperature",
    })
    expect(stored).toHaveLength(1)
    expect(scoped.objects(Contract).byId("c1").get()).rejects.toThrow(AuthorizationError)
  })

  test("the per-property channel enforces the same grant as the batch", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const editor = bindPrincipal(host, contextFor(host, ["editors"]))

    expect(
      editor.objects(Contract).byId("c1").telemetry(Contract.p.temperature).append({
        value: 21,
        unit: "degreeCelsius",
        at: new Date(),
      })
    ).rejects.toThrow(AuthorizationError)
  })
})

describe("direct writes are attributable", () => {
  // Takes the event log, not the runtime: naming `ReturnType<typeof createRuntime>` in a type
  // position is exactly the TS2589 trap the note above `createRuntime` describes.
  async function objectCreatedEvent(
    events: { read(): Promise<readonly StoredDomainEvent[]> },
    primaryId: string
  ) {
    const isMatch = (event: StoredDomainEvent) =>
      event.type === "object.created" && event.partitionKey.endsWith(primaryId)

    return (
      await waitFor(
        () => events.read(),
        (published) => published.some(isMatch)
      )
    ).find(isMatch)
  }

  test("a principal write names its actor, an auth-disabled one names nobody", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)

    // Auth-disabled execution: no authorization context, so no actor. The absence is the signal —
    // this write came from an explicitly unrestricted project, not a caller.
    await sixb.objects(Contract).upsert({ properties: { id: "system-write" } })
    const systemEvent = await objectCreatedEvent(sixb.events, "system-write")
    expect(systemEvent?.origin).toMatchObject({ kind: "runtime" })
    expect(systemEvent?.actor).toBeUndefined()

    // The principal travels onto the event, while `origin` still says the write bypassed an action.
    // Governed and direct writes stay distinguishable, and a direct write is now traceable.
    const editor = bindPrincipal(host, contextFor(host, ["editors"]))
    await editor.objects(Contract).upsert({ properties: { id: "user-write" } })
    const userEvent = await objectCreatedEvent(sixb.events, "user-write")
    expect(userEvent?.origin).toMatchObject({ kind: "runtime" })
    expect(userEvent?.actor).toEqual({ type: "user", id: "adam" })
  })

  test("a service account is recorded as a service actor", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    const serviceContext = resolveAuthorizationContext({
      principal: { type: "serviceAccount", id: "svc_ingest" },
      groupIds: ["editors"],
      roles: host.definitions.security.listResolvedRoles(),
    })

    await bindPrincipal(host, serviceContext)
      .objects(Contract)
      .upsert({ properties: { id: "svc-write" } })

    // The actor literals are `Principal["type"]`, so no translation happens on the way in.
    expect((await objectCreatedEvent(sixb.events, "svc-write"))?.actor).toEqual({
      type: "serviceAccount",
      id: "svc_ingest",
    })
  })
})

describe("bound Sixb fails closed on ungranted surfaces", () => {
  test("listLinks denies even when reached at runtime", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const principalSixb = bindPrincipal(host, contextFor(host, ["editors"]))

    // Trusted executions need this method on the shared Sixb surface. A principal can reach it too,
    // but link rows name target types no read grant covers, so the protected leaf fails closed even
    // when the principal may edit the source type.
    expect(principalSixb.objects(Contract).byId("c1").listLinks()).rejects.toThrow(
      AuthorizationError
    )
  })

  test("an explicit auth-disabled execution remains unrestricted", async () => {
    const host = createRuntime()
    const sixb = createTestSixb(host)

    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    expect((await sixb.objects.list({})).objects).toHaveLength(1)
  })

  test("ordinary principal authority cannot reach process providers", () => {
    const host = createRuntime()
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(() => scoped.blobs.stat("blob_missing")).toThrow(AuthorizationError)
    expect(() => scoped.connector(sourceConnector)).toThrow(AuthorizationError)
  })

  test("agent provider access is bound to the exact registered run", async () => {
    const host = createRuntime()
    const authorization = resolveAuthorizationContext({
      principal: { type: "serviceAccount", id: "agent-service-account" },
      groupIds: [],
      roles: host.definitions.security.listResolvedRoles(),
    })
    const scope = createAgentScope({
      projectId: host.id,
      agentId: "contract-agent",
      runId: "agent-run-1",
      context: authorization,
      source: { type: "queue", queue: "agents", jobId: "job-1" },
    })
    const agentSixb = host.withScope(scope)

    const file = await agentSixb.blobs.put({ body: new Uint8Array([1, 2, 3]) })
    expect(await agentSixb.blobs.stat(file.blobId)).not.toBeNull()
    expect(await agentSixb.connector(sourceConnector)).toEqual({})

    const mismatchedRun = host.withScope({
      authorization: scope.authorization,
      execution: {
        ...scope.execution,
        executor: { type: "agent", agentId: "contract-agent", runId: "agent-run-2" },
      },
    })
    expect(() => mismatchedRun.blobs.stat(file.blobId)).toThrow(AuthorizationError)
    expect(() => mismatchedRun.connector(sourceConnector)).toThrow(AuthorizationError)

    const forgedProvenance = host.withScope({
      authorization: scope.authorization,
      execution: { ...scope.execution, id: "exec_forged" },
    })
    expect(() => forgedProvenance.blobs.stat(file.blobId)).toThrow(AuthorizationError)
  })
})

describe("bound Sixb surface", () => {
  // Pin the composed surface so a domain facade cannot drift silently from the SDK contract.
  test("exposes exactly the allowlisted members", () => {
    const host = createRuntime()
    const _sixb = createTestSixb(host)
    const scoped = bindPrincipal(host, contextFor(host, ["commercial"]))

    expect(Object.keys(scoped).sort()).toEqual(
      [
        "actions",
        "agents",
        "blobs",
        "connector",
        "datasets",
        "events",
        "execution",
        "logs",
        "objects",
        "pipelines",
        "projections",
        "rules",
        "schedules",
        "syncs",
        "workflows",
      ].sort()
    )
    expect(Object.keys(scoped.objects).sort()).toEqual(
      [
        "appendTelemetry",
        "count",
        "executeQuery",
        "exists",
        "facet",
        "get",
        "getLatestTelemetry",
        "getPrimaryPropertyId",
        "getTelemetryHistory",
        "getTelemetryHistoryBatch",
        "getTypeById",
        "getValueTypesById",
        "isValidLinkTarget",
        "list",
        "listLinks",
        "listSubTypes",
        "listTypes",
        "removeLink",
        "resolveType",
        "upsert",
        "upsertBatch",
        "upsertLink",
        "upsertLinkBatch",
      ].sort()
    )
    expect(Object.keys(scoped.actions).sort()).toEqual(
      ["getById", "list", "listForType", "listGlobal", "request", "requestAndWait", "runs"].sort()
    )
    expect(Object.keys(scoped.datasets).sort()).toEqual(["getById", "list"])
    expect(Object.keys(scoped.workflows).sort()).toEqual(
      ["getById", "interventions", "list", "request", "requestById", "runs"].sort()
    )
    expect(Object.keys(scoped.syncs).sort()).toEqual(["getById", "list", "request", "runs"])
    expect(Object.keys(scoped.pipelines).sort()).toEqual(
      ["getById", "list", "request", "runs"].sort()
    )
    expect(Object.keys(scoped.projections).sort()).toEqual(
      ["getById", "list", "listLinks", "listObjects", "listTelemetry", "runs"].sort()
    )
    expect(Object.keys(scoped.rules).sort()).toEqual(["getById", "list", "states"])
    expect(Object.keys(scoped.agents).sort()).toEqual(["getById", "list", "runs", "threads"])
    expect(Object.keys(scoped.events).sort()).toEqual(
      ["append", "canRead", "emit", "latestCursor", "read", "subscribe"].sort()
    )
    expect(Object.keys(scoped.logs).sort()).toEqual(["assertObservable", "read", "tail"])
  })
})
