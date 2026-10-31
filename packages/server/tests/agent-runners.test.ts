import { describe, expect, test } from "bun:test"
import type { LanguageModel } from "@sixb/core"
import {
  agent,
  can,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import {
  AgentExecutionLostError,
  AgentRunRefusedError,
  claimAgentRunOverHttp,
  createHttpAgentRunSession,
  encodeWireValue,
} from "@sixb/core/internal/agents"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestAgentExecution } from "@sixb/core/testing"
import { startLapsedRunSweeper } from "../src/routes/agent-runners"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// A runner outside the worker claims a turn as the person who asked for it, then reaches the
// turn's session with the run token its claim returned. The session suite in core proves each
// operation over HTTP; this proves who reaches it.

const model = {
  providerId: "test",
  modelId: "test-model",
  definition: { kind: "language", providerId: "test", modelId: "test-model", capabilities: {} },
  stream: async () => {
    throw new Error("No model call here.")
  },
} satisfies LanguageModel
const runners = defineGroup("runners")
const projectId = "agent-runners"
const API = "http://api.localhost"
const LEASE = () => new Date(Date.now() + 60_000).toISOString()

async function setup() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [model] },
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    groups: [runners],
    roles: [defineRole("runner", { grantedTo: [runners], grants: [can.run(agent)] })],
    auth: { id: "test", kind: "dev" },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  const send = async (request: Request): Promise<Response> => app.fetch(request)

  /** A signed-in person who may use the Agent: their session cookie and CSRF pair. */
  async function person(userId: string) {
    await storage.auth.users.create({ projectId, id: userId, email: `${userId}@example.test` })
    await storage.auth.groupMemberships.upsert({
      projectId,
      userId,
      groupId: runners.id,
      source: "manual",
    })
    const credential = createSessionCredential(`ses_${userId}`)
    await storage.auth.sessions.create({
      projectId,
      id: credential.sessionId,
      userId,
      strategyId: "test",
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf-token`,
      origin: "http://app.localhost",
      "x-sixb-csrf": "csrf-token",
    }
  }

  /** Ask the Agent, as `headers`' person: the turn waits queued, as no worker runs here. */
  async function ask(headers: Record<string, string>, text: string) {
    const post = (path: string, body: unknown) =>
      send(
        new Request(`${API}${path}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).then((response) => response.json())
    const { thread } = (await post("/api/agent-threads", {})) as { readonly thread: { id: string } }
    const body = (await post(`/api/agent-threads/${thread.id}/messages`, { text })) as {
      readonly run?: { readonly id: string }
    }
    if (!body.run) throw new Error(`Expected a queued turn, got ${JSON.stringify(body)}.`)
    return body.run.id
  }

  /** The run token each run's session sent, by run. */
  const runTokens = new Map<string, string>()
  /** What each run's last claim answered, by run. */
  const claimStatuses = new Map<string, number>()

  /**
   * Claim as `headers`' person, with their session, as a runner they signed in would; its session's
   * requests then carry the run token.
   */
  function claim(headers: Record<string, string>, runId: string, leaseExpiresAt = LEASE()) {
    return claimAgentRunOverHttp({
      apiUrl: API,
      runId,
      authorization: "",
      leaseExpiresAt,
      fetch: async (request) => {
        if (new URL(request.url).pathname.endsWith("/claim")) {
          const signed = new Headers(request.headers)
          signed.delete("authorization")
          for (const [name, value] of Object.entries(headers)) signed.set(name, value)
          const response = await send(new Request(request, { headers: signed }))
          claimStatuses.set(runId, response.status)
          return response
        }
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
        if (token) runTokens.set(runId, token)
        return send(request)
      },
    })
  }

  return { storage, host, send, person, ask, claim, runTokens, claimStatuses }
}

describe("a runner outside the worker", () => {
  // Removal proof: drop the requester check from the claim route; Bob runs Ava's turn, with her
  // authority.
  test("claims a turn only as the person who asked for it", async () => {
    const { person, ask, claim, storage } = await setup()
    const ava = await person("ava")
    const bob = await person("bob")
    const runId = await ask(ava, "Summarize the open invoices.")
    // Bob takes part in Ava's conversation, so he reads the turn: he still did not ask for it.
    const run = await storage.agents.runs.getById({ projectId, id: runId })
    await storage.agents.threads.addParticipants({
      projectId,
      threadId: run?.threadId ?? "",
      principals: [{ type: "user", id: "bob" }],
      addedBy: { type: "user", id: "ava" },
      maxParticipants: 50,
    })

    expect(await claim(bob, runId).catch((error: unknown) => error)).toBeInstanceOf(
      AgentRunRefusedError
    )
    expect((await storage.agents.runs.getById({ projectId, id: runId }))?.status).toBe("queued")

    const session = await claim(ava, runId)
    expect(session?.run).toMatchObject({ id: runId, status: "running" })
    expect((await session?.plan())?.model).toMatchObject({
      provider: "test",
      modelId: "test-model",
    })
    await session?.close()
  })

  // Removal proof: compare the path's run with the token's in admitRunner no more; a run token
  // reaches another run's session.
  test("reaches with its run token only its own run's session, and nothing once it ended", async () => {
    const { person, ask, claim, send, runTokens } = await setup()
    const ava = await person("ava")
    const first = await claim(ava, await ask(ava, "First."))
    const second = await claim(ava, await ask(ava, "Second."))
    if (!first || !second) throw new Error("Expected both turns to be claimed.")
    await first.assertOwned()

    // The first run's token, pointed at the second run's session.
    const crossed = createHttpAgentRunSession({
      apiUrl: API,
      runToken: runTokens.get(first.run.id) ?? "",
      run: second.run,
      fetch: send,
    })
    expect(await crossed.plan().catch((error: unknown) => error)).toMatchObject({
      message: "[Sixb] A run's session takes that run's token.",
    })

    await first.finish({ status: "succeeded" })
    expect(await first.plan().catch((error: unknown) => error)).toBeInstanceOf(
      AgentExecutionLostError
    )
    await first.close()
    await second.close()
  })

  // Guard proof: drop the `status === "running"` branch from claimAgentRunForRunner; Ava's second
  // claim takes the lapsed turn over under a new token, for her runner to run it all again.
  test("never takes over a turn: a live one stays its runner's, a lapsed one ends interrupted", async () => {
    const { person, ask, claim, storage, claimStatuses } = await setup()
    const ava = await person("ava")
    const live = await claim(ava, await ask(ava, "Hold on."))
    if (!live) throw new Error("Expected the turn to be claimed.")

    expect(await claim(ava, live.run.id)).toBeNull()
    await live.assertOwned()

    // Its runner stopped: the lease it took has lapsed, and nothing renews it.
    const runId = await ask(ava, "Run until I stop.")
    const stopped = await claim(ava, runId, new Date(Date.now() - 1_000).toISOString())
    if (!stopped) throw new Error("Expected the turn to be claimed.")

    const refused = await claim(ava, runId).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(AgentRunRefusedError)
    expect(refused).toMatchObject({
      message: "[Sixb] This turn stopped when its runner did; send your message again.",
    })
    expect(claimStatuses.get(runId)).toBe(409)
    expect(await storage.agents.runs.getById({ projectId, id: runId })).toMatchObject({
      status: "cancelled",
      finishReason: "interrupted",
    })
    expect(await stopped.plan().catch((error: unknown) => error)).toBeInstanceOf(
      AgentExecutionLostError
    )
    await Promise.all([live.close(), stopped.close()])
  })

  // Guard proof: serve "workspace.transition" from the HTTP session again; the request reaches the
  // session instead of a 404. Drop the session's thread check as well, and Ava's run token
  // recreates Bob's workspace under the name she chose.
  test("moves no workspace, its own thread's or another's", async () => {
    const { person, ask, claim, send, storage, runTokens } = await setup()
    const ava = await person("ava")
    const bobs = await workspaceToRecover(storage)
    const runId = await ask(ava, "Summarize the open invoices.")
    const session = await claim(ava, runId)
    if (!session) throw new Error("Expected the turn to be claimed.")
    await session.assertOwned()
    const recreate = {
      action: "recreate",
      id: bobs,
      expectedSandboxName: "sixb-sb-bob",
      name: "sixb-sb-chosen-by-ava",
    } as const

    const response = await send(
      new Request(`${API}/api/agent-runs/${runId}/session/workspace.transition`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runTokens.get(runId)}`,
          "content-type": "application/json",
        },
        body: encodeWireValue({ args: [recreate] }),
      })
    )

    expect(response.status).toBe(404)
    const thread = await storage.agents.threads.getById({ projectId, id: bobs })
    expect(thread?.sandboxState).toMatchObject({ name: "sixb-sb-bob", status: "busy" })
    // Its client refuses before sending anything.
    expect(
      await session.workspace.transition(recreate as never).catch((error: unknown) => error)
    ).toMatchObject({ message: expect.stringContaining("only a runner in the worker moves") })
    await session.close()
  })

  // Removal proof: drop afterFinish from agentRunSessionHost; the child stays queued after its
  // turn ended over HTTP, with nothing to run it.
  test("stops the children of a turn it finished", async () => {
    const { person, ask, claim, storage } = await setup()
    const ava = await person("ava")
    const turn = await claim(ava, await ask(ava, "Delegate."))
    if (!turn) throw new Error("Expected the turn to be claimed.")
    const child = await turn.children.spawn({
      spawnKey: "west",
      spec: {
        model: { provider: "test", modelId: "test-model" },
        task: "Look west.",
        toolNames: [],
      },
      thread: { create: true },
      trigger: { id: "west-task", parts: [{ type: "text", text: "Look west." }] },
    })

    await turn.finish({ status: "succeeded" })

    expect(await storage.agents.runs.getById({ projectId, id: child.id })).toMatchObject({
      status: "cancelled",
    })
    await turn.close()
  })

  // Removal proof: drop startLapsedRunSweeper from SixbServer.start, or its first sweep; the run
  // whose runner stopped renewing stays running for good.
  test("ends a run its runner stopped renewing", async () => {
    const { person, ask, claim, storage, host } = await setup()
    const ava = await person("ava")
    const runId = await ask(ava, "Run until I stop.")
    const session = await claim(ava, runId, new Date(Date.now() - 1_000).toISOString())
    if (!session) throw new Error("Expected the turn to be claimed.")

    const stop = startLapsedRunSweeper(host)
    try {
      let run = await storage.agents.runs.getById({ projectId, id: runId })
      for (let turn = 0; turn < 100 && run?.status === "running"; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve))
        run = await storage.agents.runs.getById({ projectId, id: runId })
      }
      expect(run).toMatchObject({ status: "cancelled", finishReason: "interrupted" })
    } finally {
      stop()
      await session.close()
    }
  })
})

/** Bob's idle thread, whose workspace needs recovering: his last turn acquired it, then ended. */
async function workspaceToRecover(storage: InMemoryStorage): Promise<string> {
  const threadId = "thr_bob"
  await storage.agents.threads.create({
    id: threadId,
    projectId,
    ownerPrincipal: { type: "user", id: "bob" },
    sandboxParams: { clientId: "acme" },
  })
  const executionId = await createTestAgentExecution(storage, { projectId, runId: "run_bob" })
  await storage.agents.runs.create({
    id: "run_bob",
    projectId,
    executionId,
    threadId,
    triggerMessageId: "msg_bob",
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const execution = { token: "bob", queueLeaseExpiresAt: new Date(Date.now() + 60_000) }
  await storage.agents.runs.start({ projectId, id: "run_bob", execution })

  await storage.agents.threads.transitionSandbox({
    projectId,
    id: threadId,
    action: "acquire",
    runId: "run_bob",
    executionToken: "bob",
    name: "sixb-sb-bob",
    sourceFingerprint: "a".repeat(64),
  })
  await storage.agents.runs.finish({
    projectId,
    id: "run_bob",
    executionToken: "bob",
    status: "failed",
  })
  return threadId
}
