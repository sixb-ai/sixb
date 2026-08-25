import { beforeEach, describe, expect, test } from "bun:test"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import {
  can,
  defineAgent,
  defineGroup,
  defineRole,
  every,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type Principal,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { resolveAgentRunAuthorization } from "../src/agents/authority"
import { createTestSixb } from "../src/testing"

const PROJECT_ID = "delegated-authority-tests"
const model = { modelId: "test-model" } as LanguageModelV4
const ADA = { type: "user", id: "usr_ada" } as const satisfies Principal

const staff = defineGroup("staff", { label: "Staff" })
const auditors = defineGroup("auditors", { label: "Auditors" })
const analyst = defineAgent("analyst", {
  name: "Analyst",
  model,
  instructions: "x",
  groups: [staff],
})
const auditor = defineAgent("auditor", { name: "Auditor", model, instructions: "x" })

function buildHost(storage: InMemoryStorage) {
  return new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    agents: [analyst, auditor],
    mainAgent: { name: "Assistant", model, instructions: "Delegate." },
    groups: [staff, auditors],
    roles: [
      defineRole("staff.runner", { grantedTo: [staff], grants: [can.run(every.agent())] }),
      defineRole("auditors.runner", { grantedTo: [auditors], grants: [can.run(auditor)] }),
    ],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

let storage: InMemoryStorage
let sixb: ReturnType<typeof buildHost>

beforeEach(async () => {
  storage = new InMemoryStorage()
  sixb = buildHost(storage)
  const auth = storage.auth
  if (!auth) throw new Error("auth storage required")
  await auth.users.create({ id: ADA.id, projectId: PROJECT_ID, email: "ada@example.com" })
  for (const groupId of ["staff", "auditors"]) {
    await auth.groupMemberships.upsert({
      projectId: PROJECT_ID,
      userId: ADA.id,
      groupId,
      source: "manual",
    })
  }
})

/** Request a turn the way a signed-in request does: groups in, grants resolved from them. */
function requestAs(agentId: string, groupIds: readonly string[]) {
  const authorization = resolveAuthorizationContext({
    principal: ADA,
    groupIds,
    roles: sixb.definitions.security.listResolvedRoles(),
  })
  return createTestSixb(sixb, { authorization }).agents.runs.request({ agentId, text: "hello" })
}

async function executionFor(runId: string) {
  const run = await storage.agents?.runs.getById({ projectId: PROJECT_ID, id: runId })
  if (!run) throw new Error("run not found")
  const execution = await storage.executions.getById({
    projectId: PROJECT_ID,
    id: run.executionId,
  })
  if (!execution) throw new Error("execution not found")
  return { run, execution }
}

describe("main agent delegated authority", () => {
  test("mints the main agent's execution with the requester as its authority", async () => {
    const requested = await requestAs("main", ["staff"])

    const { execution } = await executionFor(requested.run.id)

    expect(execution.authorizationRef).toEqual({ type: "principal", principal: ADA })
    expect(execution.requestedBy).toEqual(ADA)
  })

  test("leaves every other agent acting as its own managed identity", async () => {
    const requested = await requestAs("analyst", ["staff"])

    const { execution } = await executionFor(requested.run.id)

    expect(execution.authorizationRef).toEqual({
      type: "principal",
      principal: { type: "serviceAccount", id: "svc_agent_analyst" },
    })
    // The human is still recorded, just not as the authority.
    expect(execution.requestedBy).toEqual(ADA)
  })

  test("resolves the delegated run's grants from the constrained snapshot, not live memberships", async () => {
    // Ada belongs to {staff, auditors}, but this request authenticated with only `staff` in scope.
    // `auditors` is what carries `run:agent` on `auditor`.
    const requested = await requestAs("main", ["staff"])
    const { run, execution } = await executionFor(requested.run.id)

    const resolved = await resolveAgentRunAuthorization({
      auth: storage.auth,
      projectId: PROJECT_ID,
      agentId: "main",
      execution,
      run,
      security: sixb.definitions.security,
    })

    expect(resolved.principal).toEqual(ADA)
    // Ada is a member of `auditors` too. Reading live memberships would pull it in here — and with
    // it `auditors.runner` — re-inflating a scoped credential to the principal's full authority.
    expect(resolved.context.groupIds).toEqual(["staff"])
    expect(resolved.context.roleIds).toEqual(["staff.runner"])
  })

  test("refuses a delegated run whose requester was suspended after admission", async () => {
    const requested = await requestAs("main", ["staff"])
    const { run, execution } = await executionFor(requested.run.id)
    await storage.auth?.users.updateStatus({
      projectId: PROJECT_ID,
      id: ADA.id,
      status: "suspended",
      updatedAt: new Date(),
    })

    await expect(
      resolveAgentRunAuthorization({
        auth: storage.auth,
        projectId: PROJECT_ID,
        agentId: "main",
        execution,
        run,
        security: sixb.definitions.security,
      })
    ).rejects.toThrow("no longer active")
  })

  test("rejects an agent execution claiming an identity that is neither its own nor the requester's", async () => {
    const requested = await requestAs("main", ["staff"])
    const { execution } = await executionFor(requested.run.id)

    // Provider-level guard: an agent execution may name a service account or its own requester,
    // never a third-party human.
    await expect(
      storage.executions.create({
        id: "exec_forged_user",
        projectId: PROJECT_ID,
        requestedBy: ADA,
        executor: { type: "agent", runId: "agt_run_forged_user" },
        source: { type: "execution", executionId: execution.id },
        correlationId: execution.correlationId,
        authorizationRef: { type: "principal", principal: { type: "user", id: "usr_mallory" } },
      })
    ).rejects.toThrow("service account or its requested-by principal")
  })
})
