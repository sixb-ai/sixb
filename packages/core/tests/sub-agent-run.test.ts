import { beforeEach, describe, expect, test } from "bun:test"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { can, defineAgent, defineGroup, defineRole, InMemoryStorage, type Principal } from "../src"
import { resolveRequesterAuthorization } from "../src/agents/authority"
import { requestSubAgentRun } from "../src/agents/sub-agent"
import type { AgentDefinition } from "../src/agents/types"
import { SecurityRegistry } from "../src/security"
import type { AgentRunRecord } from "../src/storage/agents"
import type { ExecutionRecord } from "../src/storage/executions"

const PROJECT_ID = "sub-agent-tests"
const model = { modelId: "test-model" } as LanguageModelV4

const supportGroup = defineGroup("support", { label: "Support" })
const adminGroup = defineGroup("admin", { label: "Admin" })

const supportBot = defineAgent("support-bot", { name: "Support Bot", model, instructions: "x" })
const dbAdmin = defineAgent("db-admin", { name: "DB Admin", model, instructions: "x" })

const security = new SecurityRegistry({
  groups: [supportGroup, adminGroup],
  roles: [
    defineRole("support.runner", {
      grantedTo: [supportGroup],
      grants: [can.run(supportBot)],
    }),
    defineRole("admin.runner", {
      grantedTo: [adminGroup],
      grants: [can.run(dbAdmin)],
    }),
  ],
  agentIds: new Set(["main", "support-bot", "db-admin"]),
})

const requester = { type: "user", id: "usr_requester" } as const satisfies Principal

let storage: InMemoryStorage

beforeEach(() => {
  storage = new InMemoryStorage()
})

/** The delegating main-agent run, plus the durable execution it owns. */
async function seedParent(
  options: {
    readonly requestedBy?: typeof requester
    readonly authorizationGroupIds?: string[]
  } = {}
): Promise<{ run: AgentRunRecord; execution: ExecutionRecord }> {
  const auth = storage.auth
  if (!auth) throw new Error("auth storage required")
  const now = new Date("2026-08-25T10:00:00.000Z")
  await auth.serviceAccounts.create({
    id: "svc_agent_main",
    projectId: PROJECT_ID,
    name: "Main",
    description: "Main agent",
    status: "active",
    createdByPrincipal: { type: "system", id: "test" },
    createdAt: now,
    updatedAt: now,
  })
  if (options.requestedBy?.type === "user") {
    await auth.users.create({
      id: options.requestedBy.id,
      projectId: PROJECT_ID,
      email: `${options.requestedBy.id}@example.com`,
    })
  }
  const source = await storage.executions.create({
    id: "exec_request",
    projectId: PROJECT_ID,
    executor: { type: "request", requestId: "req_1" },
    source: { type: "http", requestId: "req_1" },
    correlationId: "corr_1",
    authorizationRef: options.requestedBy
      ? { type: "principal", principal: options.requestedBy }
      : { type: "disabled" },
    ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
  })
  const execution = await storage.executions.create({
    id: "exec_main",
    projectId: PROJECT_ID,
    executor: { type: "agent", runId: "agt_run_main" },
    source: { type: "execution", executionId: source.id },
    correlationId: source.correlationId,
    ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
    authorizationRef: {
      type: "principal",
      principal: { type: "serviceAccount", id: "svc_agent_main" },
    },
  })
  const agents = storage.agents
  if (!agents) throw new Error("agent storage required")
  await agents.threads.create({
    id: "agt_thr_main",
    projectId: PROJECT_ID,
    agentId: "main",
    ownerPrincipal: options.requestedBy ?? { type: "system", id: "test" },
  })
  await agents.messages.append({
    id: "agt_msg_main",
    projectId: PROJECT_ID,
    threadId: "agt_thr_main",
    runId: null,
    role: "user",
    parts: [{ type: "text", text: "help" }],
    authorPrincipal: options.requestedBy ?? { type: "system", id: "test" },
  })
  const run = await agents.runs.create({
    id: "agt_run_main",
    projectId: PROJECT_ID,
    executionId: execution.id,
    threadId: "agt_thr_main",
    agentId: "main",
    triggerMessageId: "agt_msg_main",
    // Full memberships — the accounting snapshot, deliberately unconstrained.
    requesterGroupIds: ["admin", "support"],
    // What the request was actually authorized with.
    requesterAuthorizationGroupIds: options.authorizationGroupIds ?? ["admin", "support"],
  })
  return { run, execution }
}

function delegate(
  parent: { run: AgentRunRecord; execution: ExecutionRecord },
  agent: AgentDefinition
) {
  return requestSubAgentRun({
    storage,
    projectId: PROJECT_ID,
    security,
    agent,
    parentExecution: parent.execution,
    parentRun: parent.run,
    prompt: "do the thing",
    queueLeaseExpiresAt: new Date("2026-08-25T10:01:00.000Z"),
  })
}

describe("requestSubAgentRun", () => {
  test("admits a delegated run the requester is allowed to start", async () => {
    const parent = await seedParent({ requestedBy: requester })

    const { run, execution, threadId } = await delegate(parent, supportBot)

    expect(run.agentId).toBe("support-bot")
    // Already running: a run left `queued` would be picked up by the queue-reconciliation scan and
    // started a second time, or reclaimed out from under the in-process turn.
    expect(run.status).toBe("running")
    expect(run.execution?.token).toBeTruthy()
    // Linked to the delegating execution, so the whole chain is walkable.
    expect(execution.source).toEqual({ type: "execution", executionId: "exec_main" })
    expect(execution.requestedBy).toEqual(requester)
    expect(execution.correlationId).toBe("corr_1")
    expect(threadId).not.toBe("agt_thr_main")
  })

  test("denies a run with no human requester instead of waving it through", async () => {
    const parent = await seedParent()

    // `evaluate(undefined, ...)` reports `allowed: true` — the trusted-primitive convention in
    // `authorization/decision.ts:99-109`. Fold the null check into `isAllowed(...)` and this test
    // passes while the check has become a bypass, so it is asserted on its own.
    await expect(delegate(parent, supportBot)).rejects.toThrow("Unknown agent 'support-bot'")

    // A denial must not leave durable wreckage behind.
    expect((await storage.agents?.runs.list({ projectId: PROJECT_ID }))?.runs).toHaveLength(1)
    expect((await storage.agents?.threads.list({ projectId: PROJECT_ID }))?.threads).toHaveLength(1)
  })

  test("honours a credential-constrained requester rather than their full membership", async () => {
    // The requester belongs to {admin, support}, but this request authenticated with a token
    // scoped to ["support"]. Authorizing off `requesterGroupIds` would re-inflate that token to
    // full authority and reach `db-admin`, which the same token is refused directly over HTTP.
    const parent = await seedParent({
      requestedBy: requester,
      authorizationGroupIds: ["support"],
    })

    await expect(delegate(parent, supportBot)).resolves.toBeDefined()
    await expect(delegate(parent, dbAdmin)).rejects.toThrow("Unknown agent 'db-admin'")
  })

  test("refuses the main agent as a target, bounding delegation at one level", async () => {
    const parent = await seedParent({ requestedBy: requester })
    const mainAsTarget = defineAgent("main", { name: "Assistant", model, instructions: "x" })

    await expect(delegate(parent, mainAsTarget)).rejects.toThrow("Unknown agent 'main'")
  })

  test("owns the child thread with the delegating agent, keeping it out of the requester's list", async () => {
    const parent = await seedParent({ requestedBy: requester })

    const { threadId } = await delegate(parent, supportBot)

    const owned = await storage.agents?.threads.list({
      projectId: PROJECT_ID,
      ownerPrincipal: requester,
    })
    expect(owned?.threads.map((thread) => thread.id)).toEqual(["agt_thr_main"])
    const child = await storage.agents?.threads.getById({ projectId: PROJECT_ID, id: threadId })
    expect(child?.ownerPrincipal).toEqual({ type: "serviceAccount", id: "svc_agent_main" })
  })
})

describe("resolveRequesterAuthorization", () => {
  test("resolves roles live while keeping the constrained group snapshot", async () => {
    const parent = await seedParent({
      requestedBy: requester,
      authorizationGroupIds: ["support"],
    })

    const context = resolveRequesterAuthorization({
      execution: parent.execution,
      run: parent.run,
      security,
    })

    expect(context?.groupIds).toEqual(["support"])
    expect([...(context?.grants["run:agent"] ?? [])]).toEqual(["support-bot"])
  })

  test("returns null when the run has no human requester", async () => {
    const parent = await seedParent()

    expect(
      resolveRequesterAuthorization({
        execution: parent.execution,
        run: parent.run,
        security,
      })
    ).toBeNull()
  })
})
