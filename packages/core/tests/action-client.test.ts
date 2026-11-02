import { describe, expect, test } from "bun:test"
import { defineAction, defineObjectType, prop, type RequestClient, SixbHost } from "../src"
import { drainActionRuns } from "../src/actions"
import { setRequestClientAddress } from "../src/auth/client-address"
import { emptyGrantIndex } from "../src/authorization"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import { bindRequestExecution } from "../src/execution/request"
import { createTestAutomaticWorkflowExecution, createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Guard check: stop calling `bindRequestClient` in `bindRequestExecution` (`execution/request.ts`),
// or stop passing `client` in `requestAction` (`actions/request.ts`), and the request tests fail.

const PROJECT_ID = "action-client-test"
const SIGNER_ADDRESS = "203.0.113.7"
const SIGNER_AGENT = "SignerBrowser/1.0"

const Contract = defineObjectType({
  id: "Contract",
  name: "Contract",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("signedFrom", "string", { nullable: true }),
  ],
})

type Seen = { readonly phase: string; readonly client: RequestClient | undefined }

function defineSignContract(seen: Seen[]) {
  return defineAction("signContract")
    .on(Contract)
    .params({})
    .validate(({ client }) => {
      seen.push({ phase: "validate", client })
    })
    .writeback(({ client }) => {
      seen.push({ phase: "writeback", client })
    })
    .edits(({ objects, subject, client }) => {
      seen.push({ phase: "edits", client })
      objects(Contract)
        .byId(subject.primaryId)
        .update({ signedFrom: client?.address ?? null })
    })
    .effects(({ client }) => {
      seen.push({ phase: "effects", client })
    })
}

async function setup() {
  const seen: Seen[] = []
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [Contract],
    actions: [defineSignContract(seen)],
    onError: () => {},
    ...deps,
  })
  await deps.storage.auth.users.create({
    projectId: PROJECT_ID,
    id: "usr_signer",
    email: "signer@example.com",
  })
  await createTestSixb(host)
    .objects(Contract)
    .upsert({ properties: { id: "c1" } })
  return { host, seen }
}

function signerRequest(headers: Record<string, string> = { "user-agent": SIGNER_AGENT }) {
  const request = new Request("http://localhost/api/actions/signContract", {
    method: "POST",
    headers,
  })
  // The server resolves the address at the socket, before any route runs.
  setRequestClientAddress(request, SIGNER_ADDRESS)
  return request
}

function bindSigner(host: SixbHost, request: Request) {
  return bindRequestExecution(host, {
    request,
    authorization: {
      type: "principal",
      context: {
        principal: { type: "user", id: "usr_signer" },
        groupIds: [],
        roleIds: [],
        grants: {
          ...emptyGrantIndex(),
          "view:object": new Set([Contract.id]),
          "apply:action": new Set(["signContract"]),
        },
      },
    },
  })
}

function sign(sixb: ReturnType<typeof bindSigner>) {
  return sixb.objects(Contract).requestAction({ id: "c1", actionId: "signContract", params: {} })
}

function phasesSaw(seen: readonly Seen[], client: RequestClient | undefined) {
  expect(seen).toEqual(
    ["validate", "writeback", "edits", "effects"].map((phase) => ({ phase, client }))
  )
}

describe("client", () => {
  test("is the HTTP request's client in every phase, and is never stored by Sixb", async () => {
    const { host, seen } = await setup()

    const run = await sign(bindSigner(host, signerRequest()))
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    phasesSaw(seen, { address: SIGNER_ADDRESS, userAgent: SIGNER_AGENT })
    expect(Object.isFrozen(seen[0]?.client)).toBe(true)

    // The handler stored it on purpose; the run and its executions did not.
    const contract = await createTestSixb(host).objects(Contract).get("c1")
    expect(contract?.properties.signedFrom).toBe(SIGNER_ADDRESS)
    const stored = await host.storage.actionRuns?.getById({ projectId: PROJECT_ID, id: run.id })
    const execution = await host.storage.executions.getById({
      projectId: PROJECT_ID,
      id: run.executionId,
    })
    for (const record of [run, stored, execution]) {
      expect(JSON.stringify(record)).not.toContain(SIGNER_ADDRESS)
      expect(JSON.stringify(record)).not.toContain(SIGNER_AGENT)
    }
  })

  test("leaves out what the request does not carry, and caps the user agent", async () => {
    const { host, seen } = await setup()
    const request = new Request("http://localhost/api/actions/signContract", {
      headers: { "user-agent": `  ${"A".repeat(600)}  ` },
    })

    await sign(bindSigner(host, request))
    await drainActionRuns(host, 5_000)

    phasesSaw(seen, { address: undefined, userAgent: "A".repeat(512) })
  })

  test("is undefined without an HTTP request", async () => {
    const { host, seen } = await setup()

    await createTestSixb(host)
      .objects(Contract)
      .requestAction({ id: "c1", actionId: "signContract", params: {} })
    await drainActionRuns(host, 5_000)

    phasesSaw(seen, undefined)
  })

  test("is undefined for an action a workflow requests", async () => {
    const { host, seen } = await setup()
    const executionId = await createTestAutomaticWorkflowExecution(host.storage.executions, {
      projectId: PROJECT_ID,
      workflowId: "sign-on-schedule",
      runId: "wfrun_sign",
    })
    const execution = await host.storage.executions.getById({
      projectId: PROJECT_ID,
      id: executionId,
    })
    if (!execution) throw new Error(`Expected workflow execution '${executionId}'.`)
    const workflow = bindDurablePrimitiveExecution(host, {
      execution,
      primitive: { kind: "workflow", id: "sign-on-schedule", runId: "wfrun_sign" },
    })

    await workflow.sixb.actions.request({
      actionId: "signContract",
      subject: { kind: "object", objectTypeId: Contract.id, primaryId: "c1" },
      params: {},
    })
    await drainActionRuns(host, 5_000)

    phasesSaw(seen, undefined)
  })
})
