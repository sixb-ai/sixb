import { describe, expect, test } from "bun:test"
import {
  applications,
  can,
  canAccessApplication,
  col,
  defineAction,
  defineAgent,
  defineConnector,
  defineDataset,
  defineGroup,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRole,
  defineSync,
  every,
  isApplicationAccessControlled,
  prop,
  type RoleDefinition,
  resolveAuthorizationContext,
  Sixb,
} from "../src"
import { createSessionCredential } from "../src/auth"
import { resolveRoleGrants } from "../src/authorization"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Contract = defineObjectType({
  id: "contract",
  name: "Contract",
  properties: [prop("id", "string", { required: true, primary: true })],
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

const contractsPipelineStep = definePipelineStep("pipeline-contracts-step")
  .inputs({ contracts: ContractsDataset })
  .output(ContractsDataset)
  .run(async () => {})

const invoicesPipelineStep = definePipelineStep("pipeline-invoices-step")
  .inputs({ invoices: InvoicesDataset })
  .output(InvoicesDataset)
  .run(async () => {})

const contractsPipeline = definePipeline("pipeline-contracts").then(contractsPipelineStep)
const invoicesPipeline = definePipeline("pipeline-invoices").then(invoicesPipelineStep)

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

const sendContract = defineAction("send-contract")
  .params({})
  .edits(() => {})

const commercial = defineGroup("commercial")
const finance = defineGroup("finance")
const admins = defineGroup("admins")

const contractOperator = defineRole("contract.operator", {
  grantedTo: [commercial],
  grants: [
    can.view(Contract),
    can.apply(sendContract),
    can.run(syncContracts),
    can.run(contractsPipeline),
    can.run(contractAgent),
  ],
})

const invoiceViewer = defineRole("invoice.viewer", {
  grantedTo: [finance],
  grants: [can.view(Invoice), can.view(InvoicesDataset)],
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
    can.run(every.agent()),
  ],
})

const principal = { type: "user", id: "adam" } as const

describe("resolveAuthorizationContext", () => {
  // The registry expands grants against the registered universe at startup;
  // here we expand by hand so the resolver can be exercised in isolation.
  const universe = {
    applicationIds: new Set(["atlas", "app"]),
    objectTypeIds: new Set(["contract", "signed-contract", "invoice"]),
    datasetIds: new Set(["raw.contracts", "raw.invoices"]),
    actionIds: new Set(["send-contract"]),
    workflowIds: new Set<string>(),
    syncIds: new Set(["sync-contracts", "sync-invoices"]),
    pipelineIds: new Set(["pipeline-contracts", "pipeline-invoices"]),
    agentIds: new Set(["contract-agent", "invoice-agent"]),
    observableIds: new Set(["logs"]),
    getSubTypes: (objectTypeId: string) => (objectTypeId === "contract" ? ["signed-contract"] : []),
  }

  const resolve = (
    groupIds: readonly string[],
    roles: readonly RoleDefinition[],
    sessionId?: string
  ) =>
    resolveAuthorizationContext({
      principal,
      ...(sessionId ? { sessionId } : {}),
      groupIds,
      roles: roles.map((role) => ({
        id: role.id,
        grantedToGroupIds: role.grantedToGroupIds,
        grants: resolveRoleGrants(role, universe),
      })),
    })

  test("application access becomes an allowlist when a role grants it", () => {
    const atlasAccess = defineRole("atlas.access", {
      grantedTo: [admins],
      grants: [can.access(applications.atlas)],
    })
    const roles = [atlasAccess].map((role) => ({
      id: role.id,
      grantedToGroupIds: role.grantedToGroupIds,
      grants: resolveRoleGrants(role, universe),
    }))
    const allowed = resolveAuthorizationContext({ principal, groupIds: [admins.id], roles })
    const denied = resolveAuthorizationContext({ principal, groupIds: [finance.id], roles })

    expect(isApplicationAccessControlled(roles, "atlas")).toBe(true)
    expect(canAccessApplication(allowed, roles, "atlas")).toBe(true)
    expect(canAccessApplication(denied, roles, "atlas")).toBe(false)
    expect(canAccessApplication(denied, roles, "app")).toBe(true)
  })

  test("matches roles by group membership and expands view grants to subtypes", () => {
    const context = resolve(["commercial"], [contractOperator, invoiceViewer], "ses_adam")

    expect(context.principal).toEqual(principal)
    expect(context.sessionId).toBe("ses_adam")
    expect(context.groupIds).toEqual(["commercial"])
    expect(context.roleIds).toEqual(["contract.operator"])
    expect(context.grants["view:object"]).toEqual(new Set(["contract", "signed-contract"]))
    expect(context.grants["view:dataset"]).toEqual(new Set())
    expect(context.grants["apply:action"]).toEqual(new Set(["send-contract"]))
    expect(context.grants["run:sync"]).toEqual(new Set(["sync-contracts"]))
    expect(context.grants["run:pipeline"]).toEqual(new Set(["pipeline-contracts"]))
    expect(context.grants["run:agent"]).toEqual(new Set(["contract-agent"]))
    expect(context.grants["observe:logs"]).toEqual(new Set())
  })

  test("unions grants across all matched roles", () => {
    const context = resolve(["commercial", "finance"], [contractOperator, invoiceViewer])

    expect(context.roleIds).toEqual(["contract.operator", "invoice.viewer"])
    expect(context.grants["view:object"]).toEqual(
      new Set(["contract", "signed-contract", "invoice"])
    )
    expect(context.grants["view:dataset"]).toEqual(new Set(["raw.invoices"]))
    expect(context.grants["run:sync"]).toEqual(new Set(["sync-contracts"]))
    expect(context.grants["run:pipeline"]).toEqual(new Set(["pipeline-contracts"]))
    expect(context.grants["run:agent"]).toEqual(new Set(["contract-agent"]))
  })

  test("principals without matching roles resolve to empty grants", () => {
    const context = resolve(["engineering"], [contractOperator, invoiceViewer, adminOperator])

    expect(context.roleIds).toEqual([])
    expect(context.grants["view:object"].size).toBe(0)
    expect(context.grants["view:dataset"].size).toBe(0)
    expect(context.grants["apply:action"].size).toBe(0)
    expect(context.grants["run:workflow"].size).toBe(0)
    expect(context.grants["run:sync"].size).toBe(0)
    expect(context.grants["run:pipeline"].size).toBe(0)
    expect(context.grants["run:agent"].size).toBe(0)
  })

  test("expands broad grants to the registered universe", () => {
    const context = resolve(["admins"], [contractOperator, invoiceViewer, adminOperator])

    expect(context.roleIds).toEqual(["admin.operator"])
    expect(context.grants["view:object"]).toEqual(
      new Set(["contract", "signed-contract", "invoice"])
    )
    expect(context.grants["view:dataset"]).toEqual(new Set(["raw.contracts", "raw.invoices"]))
    expect(context.grants["apply:action"]).toEqual(new Set(["send-contract"]))
    expect(context.grants["run:workflow"].size).toBe(0)
    expect(context.grants["run:sync"]).toEqual(new Set(["sync-contracts", "sync-invoices"]))
    expect(context.grants["run:pipeline"]).toEqual(
      new Set(["pipeline-contracts", "pipeline-invoices"])
    )
    expect(context.grants["run:agent"]).toEqual(new Set(["contract-agent", "invoice-agent"]))
  })

  test("edit and append expand to the whole type universe but never to subtypes", () => {
    const writer = defineRole("everything.writer", {
      grantedTo: [admins],
      grants: [can.edit(every.object()), can.append(every.object())],
    })

    const context = resolve(["admins"], [writer])

    // `every.object()` is the registered universe, so subtypes are in it on their own account.
    expect(context.grants["edit:object"]).toEqual(
      new Set(["contract", "signed-contract", "invoice"])
    )
    expect(context.grants["append:telemetry"]).toEqual(
      new Set(["contract", "signed-contract", "invoice"])
    )

    // Naming the parent is the case that must NOT reach the child: a type added under Contract
    // later would otherwise become writable without anyone granting it.
    const parentWriter = defineRole("contract.writer", {
      grantedTo: [admins],
      grants: [can.view(Contract), can.edit(Contract), can.append(Contract)],
    })

    const narrow = resolve(["admins"], [parentWriter])

    expect(narrow.grants["view:object"]).toEqual(new Set(["contract", "signed-contract"]))
    expect(narrow.grants["edit:object"]).toEqual(new Set(["contract"]))
    expect(narrow.grants["append:telemetry"]).toEqual(new Set(["contract"]))
  })

  test("except() on a write grant carves out the named types", () => {
    const mostWritable = defineRole("most.writable", {
      grantedTo: [admins],
      grants: [can.edit(every.object().except([Invoice]))],
    })

    const context = resolve(["admins"], [mostWritable])

    expect(context.grants["edit:object"]).toEqual(new Set(["contract", "signed-contract"]))
    expect(context.grants["edit:object"].has("invoice")).toBe(false)
  })

  test("except() excludes named datasets and keeps the rest of the dataset universe", () => {
    const mostDatasets = defineRole("most.datasets", {
      grantedTo: [admins],
      grants: [can.view(every.dataset().except([InvoicesDataset]))],
    })

    const context = resolve(["admins"], [mostDatasets])

    expect(context.grants["view:dataset"]).toEqual(new Set(["raw.contracts"]))
    expect(context.grants["view:dataset"].has("raw.invoices")).toBe(false)
  })

  test("except() excludes named syncs and keeps the rest of the sync universe", () => {
    const mostSyncs = defineRole("most.syncs", {
      grantedTo: [admins],
      grants: [can.run(every.sync().except([syncInvoices]))],
    })

    const context = resolve(["admins"], [mostSyncs])

    expect(context.grants["run:sync"]).toEqual(new Set(["sync-contracts"]))
    expect(context.grants["run:sync"].has("sync-invoices")).toBe(false)
  })

  test("except() excludes named pipelines and keeps the rest of the pipeline universe", () => {
    const mostPipelines = defineRole("most.pipelines", {
      grantedTo: [admins],
      grants: [can.run(every.pipeline().except([invoicesPipeline]))],
    })

    const context = resolve(["admins"], [mostPipelines])

    expect(context.grants["run:pipeline"]).toEqual(new Set(["pipeline-contracts"]))
    expect(context.grants["run:pipeline"].has("pipeline-invoices")).toBe(false)
  })

  test("except() excludes named agents and keeps the rest of the agent universe", () => {
    const mostAgents = defineRole("most.agents", {
      grantedTo: [admins],
      grants: [can.run(every.agent().except([invoiceAgent]))],
    })

    const context = resolve(["admins"], [mostAgents])

    expect(context.grants["run:agent"]).toEqual(new Set(["contract-agent"]))
    expect(context.grants["run:agent"].has("invoice-agent")).toBe(false)
  })

  test("except() excludes the named types and keeps the rest of the universe", () => {
    const mostObjects = defineRole("most.objects", {
      grantedTo: [admins],
      grants: [can.view(every.object().except([Invoice]))],
    })

    const context = resolve(["admins"], [mostObjects])

    expect(context.grants["view:object"]).toEqual(new Set(["contract", "signed-contract"]))
    expect(context.grants["view:object"].has("invoice")).toBe(false)
  })

  test("except is per-grant: another role can re-grant an excluded type", () => {
    const allButInvoice = defineRole("all.but.invoice", {
      grantedTo: [admins],
      grants: [can.view(every.object().except([Invoice]))],
    })
    const invoiceOnly = defineRole("invoice.only", {
      grantedTo: [finance],
      grants: [can.view(Invoice)],
    })

    const context = resolve(["admins", "finance"], [allButInvoice, invoiceOnly])

    expect(context.grants["view:object"]).toEqual(
      new Set(["contract", "signed-contract", "invoice"])
    )
  })
})

describe("auth.createAuthorizationContext", () => {
  function createRuntime() {
    const deps = createTestRuntimeDeps()
    const sixb = new Sixb({
      ontology: [Contract, SignedContract, Invoice],
      datasets: [ContractsDataset, InvoicesDataset],
      syncs: [syncContracts, syncInvoices],
      pipelines: [contractsPipeline, invoicesPipeline],
      actions: [sendContract],
      agents: [contractAgent, invoiceAgent],
      groups: [commercial, finance],
      roles: [contractOperator, invoiceViewer],
      auth: { id: "test", kind: "dev" },
      ...deps,
    })
    return { sixb, deps }
  }

  async function seedAuthenticatedUser(
    projectId: string,
    deps: ReturnType<typeof createTestRuntimeDeps>,
    params: {
      readonly userId: string
      readonly email: string
      readonly groupIds: readonly string[]
    }
  ): Promise<{ request: Request; sessionId: string }> {
    const credential = createSessionCredential(`ses_${params.userId}`)
    await deps.storage.auth.users.create({
      id: params.userId,
      projectId,
      email: params.email,
    })
    for (const groupId of params.groupIds) {
      await deps.storage.auth.groupMemberships.upsert({
        projectId,
        userId: params.userId,
        groupId,
        source: "manual",
      })
    }
    await deps.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId,
      userId: params.userId,
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    return {
      request: new Request("http://localhost/api/objects", {
        headers: { cookie: `sixb_session=${credential.cookieValue}` },
      }),
      sessionId: credential.sessionId,
    }
  }

  test("resolves the context from an authenticated request", async () => {
    const { sixb, deps } = createRuntime()
    const { request, sessionId } = await seedAuthenticatedUser(sixb.id, deps, {
      userId: "adam",
      email: "adam@example.com",
      groupIds: ["commercial"],
    })

    const context = await sixb.auth.createAuthorizationContext(request)

    expect(context.principal).toEqual({ type: "user", id: "adam" })
    expect(context.sessionId).toBe(sessionId)
    expect(context.groupIds).toEqual(["commercial"])
    expect(context.roleIds).toEqual(["contract.operator"])
    expect(context.grants["view:object"]).toEqual(new Set(["contract", "signed-contract"]))
    expect(context.grants["view:dataset"]).toEqual(new Set())
    expect(context.grants["apply:action"]).toEqual(new Set(["send-contract"]))
    expect(context.grants["run:sync"]).toEqual(new Set(["sync-contracts"]))
    expect(context.grants["run:pipeline"]).toEqual(new Set(["pipeline-contracts"]))
    expect(context.grants["run:agent"]).toEqual(new Set(["contract-agent"]))
  })

  test("rejects unauthenticated requests", async () => {
    const { sixb } = createRuntime()

    expect(
      sixb.auth.createAuthorizationContext(new Request("http://localhost/api/objects"))
    ).rejects.toThrow("[Sixb] Authentication is required.")
  })

  test("contextFromSession matches the request-based context", async () => {
    const { sixb, deps } = createRuntime()
    const { request } = await seedAuthenticatedUser(sixb.id, deps, {
      userId: "adam",
      email: "adam@example.com",
      groupIds: ["commercial", "finance"],
    })

    const session = await sixb.auth.getSession(request)
    if (!session.authenticated) {
      throw new Error("Expected an authenticated session.")
    }

    expect(sixb.auth.contextFromSession(session)).toEqual(
      await sixb.auth.createAuthorizationContext(request)
    )
  })
})
