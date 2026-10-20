import { describe, expect, test } from "bun:test"
import {
  type AuthorizablePrincipal,
  type AuthorizationContext,
  defineAction,
  defineObjectType,
  prop,
  ref,
  SixbHost,
  userRef,
} from "../src"
import { drainActionRuns } from "../src/actions"
import { emptyGrantIndex } from "../src/authorization"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import {
  createTestAutomaticWorkflowExecution,
  createTestSixb,
  createTestWorkflowExecution,
} from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// Guard check: remove `requestedBy` from `createBasePhaseContext` (`actions/run/context.ts`), or
// stop setting it in `buildActionContext` (`actions/run/execute.ts`), and every test that expects a
// requester fails.

const PROJECT_ID = "action-requester-test"

const ALICE = userRef("usr_alice")
const BOB = userRef("usr_bob")
const BOT = Object.freeze({ type: "serviceAccount" as const, id: "sa_bot" })

const Ticket = defineObjectType({
  id: "Ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("assignee", ref.user(), { nullable: true }),
    prop("closedBy", ref.user(), { nullable: true }),
  ],
})

type Seen = { readonly phase: string; readonly requestedBy: AuthorizablePrincipal | undefined }

/** Close a ticket, recording who each phase saw, and storing a user requester as `closedBy`. */
function defineCloseTicket(seen: Seen[]) {
  return defineAction("closeTicket")
    .on(Ticket)
    .params({})
    .validate(({ requestedBy }) => {
      seen.push({ phase: "validate", requestedBy })
    })
    .writeback(({ requestedBy }) => {
      seen.push({ phase: "writeback", requestedBy })
    })
    .edits(({ objects, subject, requestedBy }) => {
      seen.push({ phase: "edits", requestedBy })

      if (requestedBy?.type === "user") {
        objects(Ticket).byId(subject.primaryId).update({ closedBy: requestedBy })
      }
    })
    .effects(({ requestedBy }) => {
      seen.push({ phase: "effects", requestedBy })
    })
}

const closeAssignedTicket = defineAction("closeAssignedTicket")
  .on(Ticket)
  .params({})
  .validate(({ target, requestedBy }) => {
    const assignee = target.properties.assignee

    if (requestedBy?.type !== "user" || assignee?.id !== requestedBy.id) {
      return { error: "Only the assignee can close this ticket." }
    }
  })
  .edits(({ objects, subject, requestedBy }) => {
    if (requestedBy?.type === "user") {
      objects(Ticket).byId(subject.primaryId).update({ closedBy: requestedBy })
    }
  })

async function setup() {
  const seen: Seen[] = []
  const deps = createTestRuntimeDeps()
  const closeTicket = defineCloseTicket(seen)
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [Ticket],
    actions: [closeTicket, closeAssignedTicket],
    onError: () => {},
    ...deps,
  })

  const auth = deps.storage.auth
  for (const user of [ALICE, BOB]) {
    await auth.users.create({ projectId: PROJECT_ID, id: user.id, email: `${user.id}@example.com` })
  }
  await auth.serviceAccounts.create({ projectId: PROJECT_ID, id: BOT.id, name: "Bot" })

  await createTestSixb(host)
    .objects(Ticket)
    .upsert({ properties: { id: "t1", assignee: ALICE } })

  return { host, seen }
}

function requestAs(host: SixbHost, principal: AuthorizablePrincipal) {
  const authorization: AuthorizationContext = {
    principal,
    groupIds: [],
    roleIds: [],
    grants: {
      ...emptyGrantIndex(),
      "view:object": new Set([Ticket.id]),
      "apply:action": new Set(["closeTicket", "closeAssignedTicket"]),
    },
  }
  return createTestSixb(host, { authorization })
}

async function closedBy(host: SixbHost) {
  const ticket = await createTestSixb(host).objects(Ticket).get("t1")
  return ticket?.properties.closedBy
}

function phasesSaw(seen: readonly Seen[], requestedBy: AuthorizablePrincipal | undefined) {
  expect(seen).toEqual(
    ["validate", "writeback", "edits", "effects"].map((phase) => ({ phase, requestedBy }))
  )
}

describe("requestedBy", () => {
  test("is the user who requested the run, in every phase, and stores as a user reference", async () => {
    const { host, seen } = await setup()

    const run = await requestAs(host, ALICE)
      .objects(Ticket)
      .requestAction({ id: "t1", actionId: "closeTicket", params: {} })
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    phasesSaw(seen, ALICE)
    expect(Object.isFrozen(seen[0]?.requestedBy)).toBe(true)
    expect(await closedBy(host)).toEqual(ALICE)
  })

  test("is the service account that requested the run", async () => {
    const { host, seen } = await setup()

    const run = await requestAs(host, BOT)
      .objects(Ticket)
      .requestAction({ id: "t1", actionId: "closeTicket", params: {} })
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    phasesSaw(seen, BOT)
    expect(await closedBy(host)).toBeUndefined()
  })

  test("is undefined when no principal requested the run", async () => {
    const { host, seen } = await setup()

    const run = await createTestSixb(host)
      .objects(Ticket)
      .requestAction({ id: "t1", actionId: "closeTicket", params: {} })
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    phasesSaw(seen, undefined)
  })

  test("is undefined for an action a scheduled workflow requests", async () => {
    const { host, seen } = await setup()
    const executionId = await createTestAutomaticWorkflowExecution(host.storage.executions, {
      projectId: PROJECT_ID,
      workflowId: "nightly-close",
      runId: "wfrun_nightly",
      source: { type: "schedule", eventId: "evt_nightly" },
    })

    const run = await requestFromWorkflow(host, executionId, "nightly-close", "wfrun_nightly")
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    phasesSaw(seen, undefined)
  })

  test("is the user who started the workflow whose step requests the action", async () => {
    const { host, seen } = await setup()
    const executionId = await createTestWorkflowExecution(host.storage.executions, {
      projectId: PROJECT_ID,
      workflowId: "close-on-request",
      runId: "wfrun_alice",
      requestedBy: ALICE,
    })

    const run = await requestFromWorkflow(host, executionId, "close-on-request", "wfrun_alice")
    await drainActionRuns(host, 5_000)

    expect(run.status).toBe("succeeded")
    phasesSaw(seen, ALICE)
    expect(await closedBy(host)).toEqual(ALICE)
  })

  test("lets a validator admit only the assignee", async () => {
    const { host } = await setup()
    const request = (principal: AuthorizablePrincipal) =>
      requestAs(host, principal)
        .objects(Ticket)
        .requestAction({ id: "t1", actionId: "closeAssignedTicket", params: {} })

    for (const principal of [BOB, BOT]) {
      expect(await request(principal)).toMatchObject({
        status: "failed",
        error: {
          code: "action.rejected",
          message: "Only the assignee can close this ticket.",
          details: { phase: "validation" },
        },
      })
    }
    expect(await closedBy(host)).toBeUndefined()

    expect(await request(ALICE)).toMatchObject({ status: "succeeded" })
    expect(await closedBy(host)).toEqual(ALICE)
  })
})

/** Request `closeTicket` from inside a workflow run, as one of its steps does. */
async function requestFromWorkflow(
  host: SixbHost,
  executionId: string,
  workflowId: string,
  runId: string
) {
  const execution = await host.storage.executions.getById({
    projectId: PROJECT_ID,
    id: executionId,
  })
  if (!execution) throw new Error(`Expected workflow execution '${executionId}'.`)

  const workflow = bindDurablePrimitiveExecution(host, {
    execution,
    primitive: { kind: "workflow", id: workflowId, runId },
  })

  return workflow.sixb.actions.request({
    actionId: "closeTicket",
    subject: { kind: "object", objectTypeId: Ticket.id, primaryId: "t1" },
    params: {},
  })
}
