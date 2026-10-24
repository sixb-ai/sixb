import { describe, expect, test } from "bun:test"
import {
  agent,
  can,
  col,
  defineAction,
  defineConnector,
  defineDataset,
  defineGroup,
  defineObjectType,
  definePipeline,
  definePipelineStep,
  defineRole,
  defineSync,
  every,
  project,
  prop,
  type RoleDefinition,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { createSessionCredential } from "../src/auth"
import { resolveRoleGrants } from "../src/authorization"
import { testLanguageModel } from "./helpers/language-model"
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

const model = testLanguageModel()

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
    can.run(agent),
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
    can.run(agent),
  ],
})

const principal = { type: "user", id: "adam" } as const

describe("resolveAuthorizationContext", () => {
  // The registry expands grants against the registered universe at startup;
  // here we expand by hand so the resolver can be exercised in isolation.
  const universe = {
    connectorIds: new Set<string>(),
    objectTypeIds: new Set(["contract", "signed-contract", "invoice"]),
    datasetIds: new Set(["raw.contracts", "raw.invoices"]),
    actionIds: new Set(["send-contract"]),
    shareIds: new Set<string>(),
    workflowIds: new Set<string>(),
    syncIds: new Set(["sync-contracts", "sync-invoices"]),
    pipelineIds: new Set(["pipeline-contracts", "pipeline-invoices"]),
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

  test("Agent execution, usage, limits and shared memory remain independent", () => {
    // Removal proof: making any of these grants imply another permission fails this matrix.
    const cases = [
      { grant: can.run(agent), run: true, observe: false, manage: false, memory: false },
      { grant: can.observe(agent.usage), run: false, observe: true, manage: false, memory: false },
      { grant: can.manage(agent.usage), run: false, observe: false, manage: true, memory: false },
      { grant: can.manage(agent.memory), run: false, observe: false, manage: false, memory: true },
    ]
    for (const expected of cases) {
      const role = defineRole("isolated-capability", {
        grantedTo: [admins],
        grants: [expected.grant],
      })
      const context = resolve([admins.id], [role])
      expect(context.grants["run:agent"]).toBe(expected.run)
      expect(context.grants["observe:aiUsage"]).toBe(expected.observe)
      expect(context.grants["manage:aiUsage"]).toBe(expected.manage)
      expect(context.grants["manage:agentMemory"]).toBe(expected.memory)
    }
  })

  test("viewing the member directory grants nothing else", () => {
    const role = defineRole("directory-reader", {
      grantedTo: [admins],
      grants: [can.view(project.users)],
    })
    const context = resolve([admins.id], [role])

    expect(context.grants["view:users"]).toBe(true)
    expect(context.grants["view:object"]).toEqual(new Set())
    expect(context.grants["observe:logs"]).toBe(false)
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
    expect(context.grants["run:agent"]).toBe(true)
    expect(context.grants["observe:logs"]).toBe(false)
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
    expect(context.grants["run:agent"]).toBe(true)
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
    expect(context.grants["run:agent"]).toBe(true)
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

  test.each([
    [
      "object views",
      can.view(every.object().except([Invoice])),
      "view:object",
      ["contract", "signed-contract"],
    ],
    [
      "object edits",
      can.edit(every.object().except([Invoice])),
      "edit:object",
      ["contract", "signed-contract"],
    ],
    [
      "dataset views",
      can.view(every.dataset().except([InvoicesDataset])),
      "view:dataset",
      ["raw.contracts"],
    ],
    ["sync runs", can.run(every.sync().except([syncInvoices])), "run:sync", ["sync-contracts"]],
    [
      "pipeline runs",
      can.run(every.pipeline().except([invoicesPipeline])),
      "run:pipeline",
      ["pipeline-contracts"],
    ],
  ] as const)("except() on %s carves out the named entries and keeps the rest of the universe", (_case, grant, key, expected) => {
    const role = defineRole("most.of.everything", { grantedTo: [admins], grants: [grant] })

    expect(resolve(["admins"], [role]).grants[key]).toEqual(new Set(expected))
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
    const sixb = new SixbHost({
      ontology: [Contract, SignedContract, Invoice],
      datasets: [ContractsDataset, InvoicesDataset],
      syncs: [syncContracts, syncInvoices],
      pipelines: [contractsPipeline, invoicesPipeline],
      actions: [sendContract],
      models: { language: [model] },
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
      tokenHash: credential.tokenHash,
      createdAt: new Date("2026-05-16T10:00:00.000Z"),
      expiresAt: new Date("2099-05-16T10:00:00.000Z"),
    })

    return {
      request: new Request("http://localhost/api/objects", {
        headers: { cookie: `sixb_session_app=${credential.cookieValue}` },
      }),
      sessionId: credential.sessionId,
    }
  }

  test("resolves the context for an authenticated caller", async () => {
    const { sixb, deps } = createRuntime()
    const { request, sessionId } = await seedAuthenticatedUser(sixb.id, deps, {
      userId: "adam",
      email: "adam@example.com",
      groupIds: ["commercial"],
    })

    const session = await sixb.auth.getSession(request)
    if (!session.authenticated) {
      throw new Error("Expected an authenticated session.")
    }
    const context = sixb.auth.contextFromSession(session)

    expect(context.principal).toEqual({ type: "user", id: "adam" })
    expect(context.sessionId).toBe(sessionId)
    expect(context.groupIds).toEqual(["commercial"])
    expect(context.roleIds).toEqual(["contract.operator"])
    expect(context.grants["view:object"]).toEqual(new Set(["contract", "signed-contract"]))
    expect(context.grants["view:dataset"]).toEqual(new Set())
    expect(context.grants["apply:action"]).toEqual(new Set(["send-contract"]))
    expect(context.grants["run:sync"]).toEqual(new Set(["sync-contracts"]))
    expect(context.grants["run:pipeline"]).toEqual(new Set(["pipeline-contracts"]))
    expect(context.grants["run:agent"]).toBe(true)
  })
})
