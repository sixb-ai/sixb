import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import {
  artifactRef,
  defineObjectType,
  InMemoryBroker,
  prop,
  ref,
  type SandboxFactory,
  SixbHost,
} from "../src"
import { AgentExecutionLostError, agentRunArtifacts } from "../src/agents"
import { announceAgentTurnEnded } from "../src/agents/run-artifacts"
import { BOARD_PREVIEW_JOB } from "../src/artifacts/canvas-display"
import { artifactLiveStream } from "../src/artifacts/live/presence"
import { emptyGrantIndex } from "../src/authorization/types"
import { bindDurableAgentExecution } from "../src/execution/agent"
import { bindRequestExecution } from "../src/execution/request"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// The rules a run publishes by, wherever it runs: the session holds them in a worker, and the API
// for a request with the run's token. The session contract proves each session applies them.

const projectId = "agent-run-artifacts"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const

// A test that times out never reaches its own `finally`.
afterEach(() => {
  jest.useRealTimers()
  jest.setSystemTime()
})

/** What a live canvas's boards read. */
const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [prop("id", "string", { primary: true, required: true })],
})

/** What Bob edits: a brief holds the document it was written from. */
const Brief = defineObjectType({
  id: "Brief",
  name: "Brief",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("doc", ref.artifact(), { nullable: true }),
  ],
})

/** The project's sandboxes, which only the agent worker opens. */
const sandboxes: SandboxFactory = {
  supportsRequestCredentials: true,
  create: async () => {
    throw new Error("Must not create a sandbox")
  },
}

async function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: projectId, ontology: [Task, Brief], ...deps, sandboxes })
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
  const as = (user: { readonly type: "user"; readonly id: string }) =>
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
        grants: {
          ...emptyGrantIndex(),
          "run:agent": true,
          "view:object": new Set([Task.id, Brief.id]),
          "edit:object": new Set([Brief.id]),
        },
      },
    },
  })
  const artifacts = agentRunArtifacts(
    { projectId, storage, domainEvents: host.events, broker: host.broker },
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
  const canvas = async (extra: Record<string, string> = {}) =>
    Promise.all(
      Object.entries({
        "canvas.json": JSON.stringify({
          items: [
            { id: "welcome", type: "board", file: "welcome.html", x: 0, y: 0, w: 390, h: 844 },
          ],
        }),
        "welcome.html": "<main><h1>Welcome</h1></main>",
        ...extra,
      }).map(async ([path, body]) => ({
        path,
        file: await deps.blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )
  const png = () =>
    deps.blobStorage.put({
      body: new TextEncoder().encode("png"),
      fileName: "welcome.png",
      mediaType: "image/png",
    })
  return { deps, host, storage, runSdk, started, artifacts, as, document, canvas, png }
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

    // The turn's writes replace the open version, and open the next one after Alice creates it.
    const next = await artifacts.publish({
      artifactId: shared.artifact.id,
      title: "Plan",
      files: await document("# Plan, revised\n"),
    })
    expect(next.version).toMatchObject({ version: 1, revision: 2 })
    await as(alice).artifacts.freeze(shared.artifact.id)
    const opened = await artifacts.publish({
      artifactId: shared.artifact.id,
      title: "Plan",
      files: await document("# Plan, third\n"),
    })
    expect(opened.version).toMatchObject({ version: 2, revision: 4 })

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

  // Guard proof: drop the holders from publishAccess in createArtifactAccessRule; Bob's turn then
  // cannot revise the brief's document, which no conversation shares.
  test("revises what an object its requester edits holds, and shares it from then on", async () => {
    const { host, artifacts, as, document } = await setup()
    const carol = { type: "user", id: "usr_carol" } as const
    const { artifact } = await as(carol).artifacts.create({
      kind: "document",
      title: "Brief",
      files: await document("# Brief\n"),
    })
    await createTestSixb(host)
      .objects(Brief)
      .upsert({ properties: { id: "b1", doc: artifactRef(artifact.id) } })

    // Alice, who cannot see briefs, reaches it once Bob's turn writes it in her conversation.
    expect(await as(alice).artifacts.access(artifact.id)).toBe("none")
    expect(await artifacts.updatable(artifact.id)).toMatchObject({ id: artifact.id })

    const revised = await artifacts.publish({
      artifactId: artifact.id,
      title: "Brief",
      files: await document("# Brief, revised\n"),
    })
    expect(revised.version).toMatchObject({
      author: bob,
      origin: { threadId: "thr_alice", runId: "run_bob" },
    })
    expect(revised.artifact.owner).toEqual(carol)
    expect(await as(alice).artifacts.access(artifact.id)).toBe("update")
  })

  // Guard proof: drop assertTakesPart from the publish transaction; Bob's turn creates an artifact
  // in Alice's conversation after she removed him from it.
  test("creates nothing once the requester left the conversation", async () => {
    const { storage, artifacts, document } = await setup()
    await storage.agents.threads.removeParticipant({
      projectId,
      threadId: "thr_alice",
      principal: bob,
    })

    const refused = await artifacts
      .publish({ kind: "document", title: "Plan", files: await document("# Plan\n") })
      .catch((error: unknown) => error)

    expect(refused).toMatchObject({ code: "not_allowed" })
    expect((await storage.artifacts.list({ projectId })).total).toBe(0)
  })

  // Guard proof: leave the answers out of the run's request for previews: its live boards are
  // never pictured, and keep their outlines.
  test("asks the render worker for its previews, with its queries answered as its requester", async () => {
    const { deps, runSdk, artifacts, canvas } = await setup()
    const query = spyOn(runSdk.artifacts, "query")
    const published = await artifacts.publish({
      kind: "canvas",
      title: "Tasks",
      files: await canvas({
        "queries/tasks.json": JSON.stringify({ kind: "start", objectTypeId: Task.id }),
      }),
    })
    expect(query).toHaveBeenCalledTimes(1)

    jest.setSystemTime(new Date(Date.now() + BOARD_PREVIEW_JOB.settleMs))
    const [claimed] = await deps.queues.renders.claim({
      projectId,
      workerId: "test",
      limit: 10,
      leaseMs: 3_600_000,
    })
    expect(claimed?.job).toMatchObject({
      type: "artifact.previews.requested",
      payload: {
        artifactId: published.artifact.id,
        version: 1,
        updatedAt: published.version.updatedAt.toISOString(),
        queries: { blobId: expect.any(String) },
      },
    })
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
    const artifacts = agentRunArtifacts(
      { projectId, storage, domainEvents: { emit: async () => {} }, broker: new InMemoryBroker() },
      started,
      "exec_bob",
      async () => ({
        artifacts: runSdk.artifacts,
        execution: runSdk.execution,
        blobs,
      })
    )

    const refused = await artifacts
      .publish({ kind: "document", title: "Plan", files: await document("# Plan\n") })
      .catch((error: unknown) => error)

    expect(ended).toBe(true)
    expect(refused).toBeInstanceOf(AgentExecutionLostError)
    expect((await storage.artifacts.list({ projectId })).total).toBe(0)
  })
  // Guard proof: write every artifact under the run itself rather than its turn in
  // `agentRunArtifacts`; the child's write then keeps a second restore point.
  test("keeps one restore point per turn, before its first write to an existing artifact", async () => {
    const { storage, started, runSdk, artifacts, as, document } = await setup()
    const plan = await as(alice).artifacts.create({
      kind: "document",
      title: "Plan",
      files: await document("# Plan\n"),
    })
    // Alice's artifact, shared in her conversation by an earlier turn of hers.
    await storage.artifacts.publish({
      projectId,
      artifactId: plan.artifact.id,
      kind: "document",
      version: { ...plan.version, origin: { threadId: "thr_alice", runId: "run_alice" } },
    })

    await artifacts.publish({
      artifactId: plan.artifact.id,
      title: "Plan",
      files: await document("# Plan, Bob\n"),
    })
    // A child of Bob's turn, writing into the same conversation.
    const childExecution = await createTestAgentExecution(storage, {
      projectId,
      runId: "run_bob_child",
      sourceExecutionId: started.executionId,
    })
    await storage.agents.runs.createSubagent({
      id: "run_bob_child",
      projectId,
      executionId: childExecution,
      parentRunId: started.id,
      parentExecutionToken: "exec_bob",
      spawnKey: "plan",
      spec: { model: { provider: "test", modelId: "test-model" }, task: "Plan", toolNames: [] },
      thread: { id: "thr_bob_child", create: true },
      trigger: { id: "msg_bob_child", parts: [{ type: "text", text: "Plan" }] },
      maxActiveChildren: 4,
    })
    const startedChild = await storage.agents.runs.start({
      projectId,
      id: "run_bob_child",
      execution: { token: "exec_child", queueLeaseExpiresAt: new Date("2099-01-01") },
    })
    const child = agentRunArtifacts(
      { projectId, storage, domainEvents: { emit: async () => {} }, broker: new InMemoryBroker() },
      startedChild,
      "exec_child",
      async () => runSdk
    )
    await child.publish({
      artifactId: plan.artifact.id,
      title: "Plan",
      files: await document("# Plan, Bob's child\n"),
    })

    const created = await artifacts.publish({
      kind: "document",
      title: "Notes",
      files: await document("# Notes\n"),
    })

    const points = await storage.artifacts.listRestorePoints({ projectId, id: plan.artifact.id })
    expect(
      points.map(({ revision, reason, turnRunId }) => ({ revision, reason, turnRunId }))
    ).toEqual([{ revision: 2, reason: "turn", turnRunId: "run_bob" }])
    expect(await child.turnWrites()).toEqual(await artifacts.turnWrites())
    expect(await artifacts.turnWrites()).toEqual(
      [
        { artifactId: plan.artifact.id, created: false, revision: 4, writes: 2 },
        { artifactId: created.artifact.id, created: true, revision: 1, writes: 1 },
      ].sort((left, right) => (left.artifactId < right.artifactId ? -1 : 1))
    )
  })

  // Guard proof: drop the announcement from AgentRunArtifacts.publish; a reader outside the
  // conversation never learns that the artifact changed.
  test("tells whoever reads an artifact it writes that it changed", async () => {
    const { host, artifacts, document } = await setup()
    const created = await artifacts.publish({
      kind: "document",
      title: "Plan",
      files: await document("# Plan\n"),
    })
    const cursor = await host.events.latestCursor()

    const written = await artifacts.publish({
      artifactId: created.artifact.id,
      title: "Plan",
      files: await document("# Plan, revised\n"),
    })

    const events = await host.events.read({
      ...(cursor === undefined ? {} : { afterCursor: cursor }),
      types: ["artifact.updated"],
    })
    expect(events.map((event) => event.payload)).toEqual([
      {
        artifactId: created.artifact.id,
        version: 1,
        revision: written.version.revision,
        frozen: false,
      },
    ])
  })
  // Guard proof: drop announceAgentBoards from AgentRunArtifacts.publish; the canvas's viewers
  // never learn which boards the turn is changing.
  test("tells a canvas's viewers which boards the turn changes, and when the turn ends", async () => {
    const { host, artifacts, canvas, deps } = await setup()
    const records = async () =>
      (
        await deps.broker.read({
          projectId,
          streamId: artifactLiveStream(created.artifact.id).id,
        })
      ).records.map(({ name, payload }) => ({ name, payload }))

    const created = await artifacts.publish({
      kind: "canvas",
      title: "Flow",
      files: await canvas(),
    })
    // A new board is news, and so is one whose page the turn rewrites.
    await artifacts.publish({
      artifactId: created.artifact.id,
      title: "Flow",
      files: await canvas({ "welcome.html": "<main><h1>Hello</h1></main>" }),
    })
    await announceAgentTurnEnded(
      { projectId, storage: deps.storage, domainEvents: host.events, broker: host.broker },
      "run_bob"
    )

    expect(await records()).toEqual([
      { name: "agent", payload: { runId: "run_bob", boards: ["welcome"], at: expect.any(String) } },
      { name: "agent", payload: { runId: "run_bob", boards: ["welcome"], at: expect.any(String) } },
      { name: "agent-ended", payload: { runId: "run_bob" } },
    ])
  })
})
