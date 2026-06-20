import { describe, expect, test } from "bun:test"
import {
  type ActionDefinition,
  AuthorizationError,
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineWorkflow,
  defineWorkflowStep,
  link,
  prop,
  ref,
  resolveAuthorizationContext,
  type SecurityRegistry,
  Sixb,
  type WorkflowDefinition,
} from "../src"
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
  links: [link("contract", Contract)],
})

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

const commercial = defineGroup("commercial")
const finance = defineGroup("finance")
const ops = defineGroup("ops")
const operations = defineGroup("operations")

const contractOperator = defineRole("contract.operator", {
  grantedTo: [commercial],
  grants: [can.view(Contract), can.apply(sendContract)],
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
  grants: [can.start(renewContract)],
})

const principal = { type: "user", id: "adam" } as const

// No explicit instance annotations anywhere in this file: naming
// Sixb<three-type tuple> in a type position (alias, param, ReturnType) trips
// TS2589 instantiation depth. Inference handles it fine.
function createRuntime() {
  return new Sixb<readonly [typeof Contract, typeof SignedContract, typeof Invoice]>({
    ontology: [Contract, SignedContract, Invoice],
    actions: [sendContract, archiveInvoice],
    workflows: [renewContract],
    groups: [commercial, finance, ops, operations],
    roles: [contractOperator, invoiceViewer, contractSender, operationsRunner],
    ...createTestRuntimeDeps(),
  })
}

function contextFor(sixb: { security: SecurityRegistry }, groupIds: readonly string[]) {
  return resolveAuthorizationContext({
    principal,
    groupIds,
    roles: sixb.security.getResolvedRoles(),
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

    expect(scoped.objects(Invoice).list()).rejects.toThrow(AuthorizationError)
    expect(scoped.objects(Invoice).get("i1")).rejects.toThrow(AuthorizationError)
    expect(scoped.objects(Invoice).byId("i1").get()).rejects.toThrow(AuthorizationError)
    expect(scoped.objects(Invoice).query().list()).rejects.toThrow(AuthorizationError)
  })

  test("queries require every touched type, not just the result type", async () => {
    const sixb = createRuntime()
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    // Starts at Invoice and ends at viewable Contract — still requires can.view(Invoice).
    const query = scoped.objects(Invoice).query()

    expect(query.list()).rejects.toThrow(AuthorizationError)
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

    expect(scoped.list({ objectTypeIds: ["invoice"] })).rejects.toThrow(AuthorizationError)
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
    ).rejects.toThrow(AuthorizationError)

    // apply without view
    const senderOnly = sixb.as(contextFor(sixb, ["ops"]))
    expect(senderOnly.listActions()).toEqual([])
    expect(senderOnly.getActionById("send-contract")).toBeNull()
    expect(
      senderOnly.objects(Contract).requestAction({ id: "c1", actionId: "send-contract" })
    ).rejects.toThrow(AuthorizationError)
  })
})

describe("sixb.as() operational access", () => {
  test("workflow runs require can.start", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const input = {
      workflowId: "renew-contract",
      input: { contract: { objectTypeId: "contract", primaryId: "c1" } },
    }

    const runner = sixb.as(contextFor(sixb, ["operations"]))
    const result = await runner.runWorkflow(input)
    expect(result.runId).toBeString()

    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect(operator.runWorkflow(input)).rejects.toThrow(AuthorizationError)
  })

  test("event visibility is derived from grants", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })

    // The operator can view Contract, so it sees the object's event.
    const operator = sixb.as(contextFor(sixb, ["commercial"]))
    expect((await operator.readEvents()).map((event) => event.type)).toContain("object.upserted")

    // The runner can start workflows but cannot view Contract, so the contract
    // event is filtered out (no workflow has run, so it sees nothing here).
    const runner = sixb.as(contextFor(sixb, ["operations"]))
    expect((await runner.readEvents()).filter((event) => event.type === "object.upserted")).toEqual(
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
    ).rejects.toThrow(AuthorizationError)
  })
})

describe("sixb.as() fails closed on ungranted surfaces", () => {
  test("writes, links, telemetry, and listLinks deny even when reached at runtime", async () => {
    const sixb = createRuntime()
    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    const scoped = sixb.as(contextFor(sixb, ["commercial"]))

    // The scoped types hide these members; the casts simulate a scoped runtime
    // context leaking into an unexposed code path.
    const objectSet = scoped.objects(Contract) as unknown as {
      upsert(input: { properties: Record<string, unknown> }): Promise<unknown>
      appendTelemetryBatch(items: readonly Record<string, unknown>[]): Promise<void>
    }

    expect(objectSet.upsert({ properties: { id: "c2" } })).rejects.toThrow(AuthorizationError)
    expect(
      objectSet.appendTelemetryBatch([{ id: "c1", properties: {}, at: new Date() }])
    ).rejects.toThrow(AuthorizationError)

    const invoiceSet = scoped.objects(Invoice) as unknown as {
      upsertLink(input: Record<string, unknown>): Promise<void>
    }
    expect(
      invoiceSet.upsertLink({
        sourceId: "i1",
        linkId: "contract",
        targetTypeId: "contract",
        targetId: "c1",
      })
    ).rejects.toThrow(AuthorizationError)

    const handle = scoped.objects(Contract).byId("c1") as unknown as {
      listLinks(): Promise<unknown>
    }
    expect(handle.listLinks()).rejects.toThrow(AuthorizationError)
  })

  test("the raw runtime stays privileged", async () => {
    const sixb = createRuntime()

    await sixb.objects(Contract).upsert({ properties: { id: "c1" } })
    expect((await sixb.list({})).objects).toHaveLength(1)
  })
})
