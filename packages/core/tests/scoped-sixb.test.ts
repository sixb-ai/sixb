import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
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
  type SecurityRegistry,
  Sixb,
  type StoredDomainEvent,
  type WorkflowDefinition,
} from "../src"
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
// actions array out of the deep Sixb<tuple> instantiation (TS2589).
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
// Sixb<three-type tuple> in a type position (alias, param, ReturnType) trips
// TS2589 instantiation depth. Inference handles it fine.
function createRuntime() {
  return new Sixb<readonly [typeof Contract, typeof SignedContract, typeof Invoice]>({
    ontology: [Contract, SignedContract, Invoice],
    datasets: [ContractsDataset, InvoicesDataset],
    actions: [sendContract, archiveInvoice],
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

function contextFor(sixb: { security: SecurityRegistry }, groupIds: readonly string[]) {
  return resolveAuthorizationContext({
    principal,
    groupIds,
    roles: sixb.security.listResolvedRoles(),
  })
}

describe("sixb.as() object reads", () => {
  test("granted types support get, list, byId.get, and query", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    expect(await scoped.objects(Contract).get("c1")).toMatchObject({ primaryId: "c1" })
    expect((await scoped.objects(Contract).list()).objects).toHaveLength(1)
    expect(await scoped.objects(Contract).byId("c1").get()).toMatchObject({ primaryId: "c1" })
    expect((await scoped.objects(Contract).query().list()).objects).toHaveLength(1)
  })

  test("view grants include subtypes", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    expect((await scoped.objects(SignedContract).list()).objects).toEqual([])
  })

  test("ungranted types deny get, list, and query", async () => {
    const sixb = createRuntime()
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    expect(scoped.objects(Invoice).list()).rejects.toHaveProperty("code", "auth.permission_denied")
    expect(scoped.objects(Invoice).get("i1")).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
    expect(scoped.objects(Invoice).byId("i1").get()).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
    expect(scoped.objects(Invoice).query().list()).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })

  test("queries require every touched type, not just the result type", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    // Starts at Invoice and ends at viewable Contract — still requires can.view(Invoice).
    const query = scoped.objects(Invoice).query()

    expect(query.list()).rejects.toHaveProperty("code", "auth.permission_denied")
  })
})

describe("sixb.as() cross-type list", () => {
  async function createSeededRuntime() {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    return sixb
  }

  test("broad listings narrow to viewable types", async () => {
    const sixb = await createSeededRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    const result = await scoped.list({})

    expect(result.objects.map((row) => row.objectTypeId)).toEqual(["contract"])
  })

  test("explicitly requesting a forbidden type fails", async () => {
    const sixb = await createSeededRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    expect(scoped.list({ objectTypeIds: ["invoice"] })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
    expect(
      (await scoped.list({ objectTypeIds: ["contract"] })).objects.map((row) => row.primaryId)
    ).toEqual(["c1"])
  })

  test("principals with no grants list nothing", async () => {
    const sixb = await createSeededRuntime()
    const scoped = sixb.as(contextFor(sixb, []))

    expect(await scoped.list({})).toEqual({ objects: [], hasMore: false, total: 0 })
  })
})

describe("sixb.as() actions", () => {
  test("object actions require apply and view together", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    const { runId } = await operator
      .objects(Contract)
      .requestAction({ id: "c1", actionId: "send-contract" })
    expect(runId).toBeString()

    // view without apply
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const viewerOnly = sixb.as(contextFor(sixb, ["finance"]))
    expect(
      viewerOnly.objects(Invoice).requestAction({ id: "i1", actionId: "archive-invoice" })
    ).rejects.toHaveProperty("code", "auth.permission_denied")

    // apply without view
    const senderOnly = sixb.as(contextFor(sixb, ["ops"]))
    expect(senderOnly.listActions()).toEqual([])
    expect(senderOnly.getActionById("send-contract")).toBeNull()
    expect(
      senderOnly.objects(Contract).requestAction({ id: "c1", actionId: "send-contract" })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })
})

describe("sixb.as() operational access", () => {
  test("dataset catalog narrows to viewable datasets", () => {
    const sixb = createRuntime()
    const operator = sixb.as(contextFor(sixb, ["commercial"]))

    expect(operator.listDatasets().map((dataset) => dataset.id)).toEqual(["raw.contracts"])
    expect(operator.getDatasetById("raw.contracts")?.id).toBe("raw.contracts")
    expect(operator.getDatasetById("raw.invoices")).toBeNull()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(runner.listDatasets()).toEqual([])
  })

  test("workflow runs require can.run", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const input = {
      workflowId: "renew-contract",
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    }

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    const result = await runner.requestWorkflowRun(input)
    expect(result.runId).toBeString()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.requestWorkflowRun(input)).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })

  test("event visibility is derived from grants", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    // The operator can view Contract, so it sees the object's event.
    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    const visibleEvents = await waitFor(
      () => operator.readEvents(),
      (published) => published.some((event) => event.type === "object.created")
    )
    expect(visibleEvents.map((event) => event.type)).toContain("object.created")

    // The runner can run workflows but cannot view Contract, so the contract
    // event is filtered out (no workflow has run, so it sees nothing here).
    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect((await runner.readEvents()).filter((event) => event.type === "object.created")).toEqual(
      []
    )
  })

  test("action metadata narrows to applicable actions", () => {
    const sixb = createRuntime()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.listActions().map((action) => action.id)).toEqual(["send-contract"])
    expect(operator.getActionById("send-contract")?.id).toBe("send-contract")
    expect(operator.getActionById("archive-invoice")).toBeNull()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(runner.listActions()).toEqual([])
  })

  test("dynamic action requests enforce apply and view", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    const { runId } = await operator.requestAction({
      actionId: "send-contract",
      subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
    })
    expect(runId).toBeString()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(
      runner.requestAction({
        actionId: "send-contract",
        subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
      })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })

  test("requestActionAndWait enforces the same grant as requestAction", async () => {
    // It requests through `requestAction` and then only reads the run it just created, so the flat
    // verb is safe to expose — but the assertion has to be pinned, not assumed from the call chain.
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    await expect(
      runner.requestActionAndWait({
        actionId: "send-contract",
        subject: { kind: "object", objectTypeId: "contract", primaryId: "c1" },
      })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })

  test("workflow catalog narrows to runnable workflows", () => {
    const sixb = createRuntime()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(runner.listWorkflows().map((workflow) => workflow.id)).toEqual([
      "renew-contract",
      "agent-review-contract",
    ])
    expect(runner.getWorkflowById("renew-contract")?.id).toBe("renew-contract")

    // No run grant: the workflow is hidden from both listing and lookup.
    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.listWorkflows()).toEqual([])
    expect(operator.getWorkflowById("renew-contract")).toBeNull()
  })

  test("workflow permission encapsulates agent nodes", async () => {
    const sixb = createRuntime()
    const workflowOnlyPrincipal = sixb.as(contextFor(sixb, ["workflow-only"]))

    expect(workflowOnlyPrincipal.listWorkflows().map((workflow) => workflow.id)).toEqual([
      "agent-review-contract",
    ])
    expect(workflowOnlyPrincipal.getWorkflowById("agent-review-contract")?.id).toBe(
      "agent-review-contract"
    )

    const { runId } = await workflowOnlyPrincipal.requestWorkflowRun({
      workflowId: "agent-review-contract",
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    })
    expect(runId).toBeString()

    // A workflow grant authorizes the composite workflow, not direct access
    // to the agents used by its implementation.
    expect(workflowOnlyPrincipal.listAgents()).toEqual([])
    expect(workflowOnlyPrincipal.getAgentById("contract-agent")).toBeNull()
    expect(
      workflowOnlyPrincipal.requestAgentRun({
        agentId: "contract-agent",
        text: "Review this contract.",
      })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })

  test("sync catalog narrows to runnable syncs", () => {
    const sixb = createRuntime()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(runner.listSyncs().map((sync) => sync.id)).toEqual(["sync-contracts"])
    expect(runner.getSyncById("sync-contracts")?.id).toBe("sync-contracts")
    expect(runner.getSyncById("sync-invoices")).toBeNull()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.listSyncs()).toEqual([])
    expect(operator.getSyncById("sync-contracts")).toBeNull()
  })

  test("a listable sync or pipeline can actually be started, and only with can.run", async () => {
    const sixb = createRuntime()
    const runner = sixb.as(contextFor(sixb, ["operations"]))

    // Before `request*`, `listSyncs()` advertised runnable syncs the caller had no way to start.
    const sync = await runner.requestSyncRun({ syncId: "sync-contracts" })
    expect(sync.syncId).toBe("sync-contracts")
    expect(sync.runId).toStartWith("run_")

    const pipeline = await runner.requestPipelineRun({ pipelineId: "contract-pipeline" })
    expect(pipeline.pipelineId).toBe("contract-pipeline")
    expect(pipeline.runId).toStartWith("run_")

    // An existing definition the principal may not run is forbidden, not missing.
    expect(runner.requestSyncRun({ syncId: "sync-invoices" })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
    expect(runner.requestPipelineRun({ pipelineId: "invoice-pipeline" })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )

    // And a genuinely unknown id is missing, under the same code the HTTP route answers with. Both
    // said `runtime.invalid_definition` before — a 500 claiming the app's own `define*()` was wrong,
    // for a caller who had simply asked for something that is not there.
    expect(runner.requestSyncRun({ syncId: "nope" })).rejects.toHaveProperty(
      "code",
      "sync.not_found"
    )
    expect(runner.requestPipelineRun({ pipelineId: "nope" })).rejects.toHaveProperty(
      "code",
      "pipeline.not_found"
    )
    expect(sixb.requestSyncRun({ syncId: "nope" })).rejects.toHaveProperty("code", "sync.not_found")
    expect(sixb.requestPipelineRun({ pipelineId: "nope" })).rejects.toHaveProperty(
      "code",
      "pipeline.not_found"
    )
  })

  test("pipeline catalog narrows to runnable pipelines", () => {
    const sixb = createRuntime()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(runner.listPipelines().map((pipeline) => pipeline.id)).toEqual(["contract-pipeline"])
    expect(runner.getPipelineById("contract-pipeline")?.id).toBe("contract-pipeline")
    expect(runner.getPipelineById("invoice-pipeline")).toBeNull()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.listPipelines()).toEqual([])
    expect(operator.getPipelineById("contract-pipeline")).toBeNull()
  })

  test("agent catalog narrows to runnable agents", () => {
    const sixb = createRuntime()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect(runner.listAgents().map((agent) => agent.id)).toEqual(["contract-agent"])
    expect(runner.getAgentById("contract-agent")?.id).toBe("contract-agent")
    expect(runner.getAgentById("invoice-agent")).toBeNull()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.listAgents()).toEqual([])
    expect(operator.getAgentById("contract-agent")).toBeNull()
  })

  test("agent run requests require can.run", async () => {
    const sixb = createRuntime()

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    const result = await runner.requestAgentRun({
      agentId: "contract-agent",
      text: "Summarize this account.",
    })
    expect(result.run.id).toBeString()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(
      operator.requestAgentRun({
        agentId: "contract-agent",
        text: "Summarize this account.",
      })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })
})

describe("sixb.as() object writes", () => {
  test("a viewer cannot write: view alone grants no edit", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    expect(scoped.objects(Contract).upsert({ properties: { id: "c2" } })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
    expect(scoped.upsertObject("contract", { id: "c2" })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })

  test("view plus edit writes, and the write is readable back", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["editors"]))

    await scoped.objects(Contract).upsert({ properties: { id: "c1" } })
    expect(await scoped.objects(Contract).byId("c1").get()).not.toBeNull()
  })

  test("edit without view is refused — an upsert answers with the merged row", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["blind-writers"]))

    expect(scoped.objects(Contract).upsert({ properties: { id: "c2" } })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })

  test("delete and restore ride on the same edit grant", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    const viewer = sixb.as(contextFor(sixb, ["commercial"]))
    expect(viewer.objects(Contract).byId("c1").delete()).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )

    const editor = sixb.as(contextFor(sixb, ["editors"]))
    await editor.objects(Contract).byId("c1").delete()
    expect(await editor.objects(Contract).byId("c1").get()).toBeNull()
    await editor.objects(Contract).byId("c1").restore()
  })

  test("ungranted types stay unwritable for a principal that can edit another type", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["editors"]))

    expect(scoped.upsertObject("invoice", { id: "i1" })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })

  test("edit does not expand to subtypes", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["editors"]))

    // `can.view(Contract)` covers `signed-contract` (view expands); `can.edit(Contract)` must not.
    expect(await scoped.objects(SignedContract).byId("s1").get()).toBeNull()
    expect(scoped.upsertObject("signed-contract", { id: "s1" })).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })
})

describe("sixb.as() link writes", () => {
  test("edit on the source and view on the target links", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = sixb.as(contextFor(sixb, ["linkers"]))

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
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = sixb.as(contextFor(sixb, ["blind-linkers"]))

    expect(
      scoped.objects(Invoice).upsertLink({
        sourceId: "i1",
        linkId: "contract",
        targetTypeId: "contract",
        targetId: "c1",
      })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })

  test("a refused item denies the whole link batch, before anything commits", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    await sixb.objects(Invoice).upsert({ properties: { id: "i1" } })
    const scoped = sixb.as(contextFor(sixb, ["blind-linkers"]))

    expect(
      scoped.upsertLinkBatch([
        {
          objectTypeId: "invoice",
          sourceId: "i1",
          linkId: "contract",
          target: { targetTypeId: "contract", targetId: "c1" },
        },
      ])
    ).rejects.toHaveProperty("code", "auth.permission_denied")

    expect(await sixb.objects(Invoice).byId("i1").listLinks()).toHaveLength(0)
  })
})

describe("sixb.as() telemetry appends", () => {
  test("append needs its own grant: an editor cannot append", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = sixb.as(contextFor(sixb, ["editors"]))

    expect(
      scoped.appendTelemetry("contract", [
        {
          id: "c1",
          properties: { temperature: { value: 21, unit: "degreeCelsius" } },
          at: new Date(),
        },
      ])
    ).rejects.toHaveProperty("code", "auth.permission_denied")
  })

  test("append works without view — the write-only ingest principal", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = sixb.as(contextFor(sixb, ["ingest"]))

    await scoped.appendTelemetry("contract", [
      {
        id: "c1",
        properties: { temperature: { value: 21, unit: "degreeCelsius" } },
        at: new Date(),
      },
    ])

    // Read back through the privileged runtime: this principal holds no view grant, which is the
    // whole point of the append/edit split.
    const stored = await sixb.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "contract",
      objectId: "c1",
      propertyId: "temperature",
    })
    expect(stored).toHaveLength(1)
    expect(scoped.objects(Contract).byId("c1").get()).rejects.toHaveProperty(
      "code",
      "auth.permission_denied"
    )
  })

  test("the per-property channel enforces the same grant as the batch", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const editor = sixb.as(contextFor(sixb, ["editors"]))

    expect(
      editor.objects(Contract).byId("c1").telemetry(Contract.p.temperature).append({
        value: 21,
        unit: "degreeCelsius",
        at: new Date(),
      })
    ).rejects.toHaveProperty("code", "auth.permission_denied")
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

  test("a scoped write names its principal, a privileged one names nobody", async () => {
    const sixb = createRuntime()

    // Privileged: no authorization context, so no actor. The absence is the signal — this write
    // came from the system, not a caller.
    await sixb.objects(Contract).upsert({ properties: { id: "system-write" } })
    const systemEvent = await objectCreatedEvent(sixb.events, "system-write")
    expect(systemEvent?.origin).toMatchObject({ kind: "runtime" })
    expect(systemEvent?.actor).toBeUndefined()

    // Scoped: the principal travels onto the event, while `origin` still says the write bypassed an
    // action. Governed and direct writes stay distinguishable, and a direct write is now traceable.
    const editor = sixb.as(contextFor(sixb, ["editors"]))
    await editor.objects(Contract).upsert({ properties: { id: "user-write" } })
    const userEvent = await objectCreatedEvent(sixb.events, "user-write")
    expect(userEvent?.origin).toMatchObject({ kind: "runtime" })
    expect(userEvent?.actor).toEqual({ type: "user", id: "adam" })
  })

  test("a service account is recorded as a service actor", async () => {
    const sixb = createRuntime()
    const serviceContext = resolveAuthorizationContext({
      principal: { type: "serviceAccount", id: "svc_ingest" },
      groupIds: ["editors"],
      roles: sixb.security.listResolvedRoles(),
    })

    await sixb
      .as(serviceContext)
      .objects(Contract)
      .upsert({ properties: { id: "svc-write" } })

    // The actor literals are `Principal["type"]`, so no translation happens on the way in.
    expect((await objectCreatedEvent(sixb.events, "svc-write"))?.actor).toEqual({
      type: "serviceAccount",
      id: "svc_ingest",
    })
  })
})

describe("sixb.as() fails closed on ungranted surfaces", () => {
  test("listLinks denies even when reached at runtime", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = sixb.as(contextFor(sixb, ["editors"]))

    // The scoped types hide this member; the cast simulates a scoped runtime context leaking into an
    // unexposed code path. Link rows name target types no read grant covers, so it stays privileged
    // even for a principal that may edit the source type.
    const handle = scoped.objects(Contract).byId("c1") as unknown as {
      listLinks(): Promise<unknown>
    }
    expect(handle.listLinks()).rejects.toHaveProperty("code", "auth.permission_denied")
  })

  test("the raw runtime stays privileged", async () => {
    const sixb = createRuntime()

    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    expect((await sixb.list({})).objects).toHaveLength(1)
  })
})

describe("ScopedSixb surface", () => {
  // The scoped value is built then `as unknown as ScopedSixb`-cast, so neither
  // the compiler nor the mask catches a member added to one side but not the
  // other. Pin the exposed members so any drift fails loudly here.
  test("exposes exactly the allowlisted members", () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    expect(Object.keys(scoped).sort()).toEqual(
      [
        "authorization",
        "getDatasetById",
        "getActionById",
        "getAgentById",
        "getObject",
        "getPipelineById",
        "getPrimaryPropertyId",
        "getSyncById",
        "getThread",
        "getWorkflowById",
        "list",
        "listActions",
        "listAgents",
        "listDatasets",
        "listPipelines",
        "listSyncs",
        "listThreads",
        "listWorkflows",
        "objects",
        "readEvents",
        "requestAction",
        "requestActionAndWait",
        "requestAgentRun",
        "requestPipelineRun",
        "requestSyncRun",
        "requestWorkflowRun",
        "appendTelemetry",
        "removeLink",
        "upsertLink",
        "upsertLinkBatch",
        "upsertObject",
        "upsertObjectBatch",
      ].sort()
    )
  })
})
