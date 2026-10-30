import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import { AgentExecutionLostError, agentRunArtifacts } from "../src/agents"
import { emptyGrantIndex } from "../src/authorization/types"
import { bindDurableAgentExecution } from "../src/execution/agent"
import { bindRequestExecution } from "../src/execution/request"
import { createTestAgentExecution } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// The rules a run publishes by, wherever it runs: the session holds them in a worker, and the API
// for a request with the run's token. The session contract proves each session applies them.

const projectId = "agent-run-artifacts"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const

async function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: projectId, ontology: [], ...deps })
  const { storage } = deps

  // Alice's conversation, with Bob taking part, and a turn Bob asked for running in it.
  await storage.agents.threads.create({ id: "thr_alice", projectId, ownerPrincipal: alice })
  await storage.agents.threads.addParticipants({
    projectId,
    threadId: "thr_alice",
    principals: [bob],
    addedBy: alice,
    maxParticipants: 50,
    addedAt: new Date("2026-10-20T09:00:00.000Z"),
  })
  const executionId = await createTestAgentExecution(storage, { projectId, runId: "run_bob" })
  await storage.agents.runs.create({
    id: "run_bob",
    projectId,
    threadId: "thr_alice",
    triggerMessageId: "msg_bob",
    executionId,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  const started = await storage.agents.runs.start({
    projectId,
    id: "run_bob",
    execution: { token: "exec_bob", queueLeaseExpiresAt: new Date("2099-01-01") },
  })

  // Signed in with a session, as a person asking in the app is.
  const as = (user: typeof alice | typeof bob) =>
    bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "session", id: `session-${user.id}` },
        context: {
          principal: user,
          sessionId: `session-${user.id}`,
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:agent": true },
        },
      },
    })
  // The run's SDK, as its session or the API binds it: Bob's turn, with Bob's authority now.
  const execution = await storage.executions.getById({ projectId, id: executionId })
  if (!execution) throw new Error("Expected the run's execution.")
  const runSdk = bindDurableAgentExecution(host, {
    execution: {
      ...execution,
      requestedBy: bob,
      authorizationRef: {
        type: "principal",
        principal: bob,
        credential: { type: "session", id: "session-usr_bob" },
      },
    },
    runId: "run_bob",
    authorization: {
      type: "principal",
      context: {
        principal: bob,
        sessionId: "session-usr_bob",
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    },
  })
  const artifacts = agentRunArtifacts(
    { projectId, storage },
    started,
    "exec_bob",
    async () => runSdk
  )

  const document = async (markdown: string) => [
    {
      path: "document.md",
      file: await deps.blobStorage.put({
        body: new TextEncoder().encode(markdown),
        fileName: "document.md",
        mediaType: "text/markdown",
      }),
    },
  ]
  return { storage, runSdk, started, artifacts, as, document }
}

describe("a run's artifacts", () => {
  // Guard proof: drop `owner` from what AgentRunArtifacts.publish prepares; Bob, who asked for the
  // turn, then owns what it creates in Alice's conversation.
  test("a new artifact belongs to the conversation's owner, authored by the requester", async () => {
    const { artifacts, document } = await setup()

    const published = await artifacts.publish({
      kind: "document",
      title: "Plan",
      files: await document("# Plan\n"),
    })

    expect(published.artifact.owner).toEqual(alice)
    expect(published.version).toMatchObject({
      author: bob,
      origin: { threadId: "thr_alice", runId: "run_bob" },
    })
  })

  // Guard proof: return the artifact whatever its publish access in `updatable`; Alice's artifact
  // from outside the conversation is then revised by Bob's turn, and shared into it.
  test("revises what the conversation shares, and nothing it cannot reach", async () => {
    const { artifacts, as, document } = await setup()
    const shared = await artifacts.publish({
      kind: "document",
      title: "Plan",
      files: await document("# Plan\n"),
    })
    const elsewhere = await as(alice).artifacts.create({
      kind: "document",
      title: "Notes",
      files: await document("# Notes\n"),
    })

    const next = await artifacts.publish({
      artifactId: shared.artifact.id,
      title: "Plan",
      files: await document("# Plan, revised\n"),
    })
    expect(next.version.version).toBe(2)

    expect(await artifacts.updatable(elsewhere.artifact.id)).toBeNull()
    const refused = await artifacts
      .publish({
        artifactId: elsewhere.artifact.id,
        title: "Notes",
        files: await document("# Notes, here\n"),
      })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: "artifact_not_found" })
  })

  // Guard proof: drop assertAgentRunOwned from the publish transaction; the run that ended while
  // its version was checked publishes.
  test("publishes nothing when the run ends while its version is checked", async () => {
    const { storage, runSdk, started, document } = await setup()
    let ended = false
    // Checking the version reads its files back: the run ends then, after the first check passed.
    const blobs: typeof runSdk.blobs = {
      ...runSdk.blobs,
      async stat(blobId) {
        if (!ended) {
          ended = true
          await storage.agents.runs.finish({
            projectId,
            id: started.id,
            executionToken: "exec_bob",
            status: "cancelled",
          })
        }
        return runSdk.blobs.stat(blobId)
      },
    }
    const artifacts = agentRunArtifacts({ projectId, storage }, started, "exec_bob", async () => ({
      artifacts: runSdk.artifacts,
      execution: runSdk.execution,
      blobs,
    }))

    const refused = await artifacts
      .publish({ kind: "document", title: "Plan", files: await document("# Plan\n") })
      .catch((error: unknown) => error)

    expect(ended).toBe(true)
    expect(refused).toBeInstanceOf(AgentExecutionLostError)
    expect((await storage.artifacts.list({ projectId })).total).toBe(0)
  })
})
