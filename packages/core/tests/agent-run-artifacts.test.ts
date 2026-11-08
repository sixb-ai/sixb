import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { defineObjectType, InMemoryBroker, prop, type SandboxFactory, SixbHost } from "../src"
import { AgentExecutionLostError, agentRunArtifacts } from "../src/agents"
import { announceAgentTurnEnded } from "../src/agents/run-artifacts"
import { BOARD_PREVIEW_JOB } from "../src/artifacts/canvas-display"
import { artifactLiveStream } from "../src/artifacts/live/presence"
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

afterEach(() => {
  jest.useRealTimers()
})

/** What a live canvas's boards read. */
const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [prop("id", "string", { primary: true, required: true })],
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
  const host = new SixbHost({ id: projectId, ontology: [Task], ...deps, sandboxes })
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
        grants: {
          ...emptyGrantIndex(),
          "run:agent": true,
          "view:object": new Set([Task.id]),
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

  // Guard proof: drop the origin check from storePreviews; Alice's version, which shows what she
  // can see, takes the pictures Bob's turn took with his rights. Drop the content check, and the
  // pictures of what Bob's turn first wrote are kept under the boards of what it wrote next.
  // Compare revisions instead, and the pictures taken while Alice created the version are refused.
  test("keeps the pictures of what it wrote, while the version holds it", async () => {
    const { storage, artifacts, as, canvas, png } = await setup()
    const previews = [
      { board: "welcome", theme: "light" as const, size: "full" as const, file: await png() },
    ]
    const store = (at: { artifactId: string; version: number; updatedAt: Date }) =>
      artifacts.storePreviews({ ...at, previews }).catch((error: unknown) => error)

    jest.setSystemTime(new Date("2026-11-08T10:00:00.000Z"))
    try {
      const first = await artifacts.publish({
        kind: "canvas",
        title: "Onboarding",
        files: await canvas(),
        rendersPreviews: true,
      })
      const { id } = first.artifact
      const writtenFirst = { artifactId: id, version: 1, updatedAt: first.version.updatedAt }

      // The turn writes the open version again: what it pictured first is no longer there.
      jest.setSystemTime(new Date("2026-11-08T10:01:00.000Z"))
      const second = await artifacts.publish({
        artifactId: id,
        title: "Onboarding",
        files: await canvas({ "welcome.html": "<main><h1>Welcome aboard</h1></main>" }),
        rendersPreviews: true,
      })
      const written = { artifactId: id, version: 1, updatedAt: second.version.updatedAt }
      expect(await store(writtenFirst)).toMatchObject({ code: "not_allowed" })
      expect(await store(written)).toEqual([])
      const outline = second.version.outline
      const renderKey =
        outline.kind === "canvas" && outline.items[0]?.type === "board"
          ? outline.items[0].renderKey
          : undefined
      expect(
        await storage.artifacts.listBoardPreviews({ projectId, renderKeys: [renderKey ?? ""] })
      ).toMatchObject([{ theme: "light", size: "full", file: previews[0]?.file }])

      // Alice creates the version while the check pictures it: it still holds what the turn
      // wrote, so the pictures are still kept.
      await as(alice).artifacts.freeze(id, { baseRevision: second.version.revision })
      expect(await store(written)).toEqual([])

      // Alice, the conversation's owner, writes it in the app: her version 2 is hers to picture.
      jest.setSystemTime(new Date("2026-11-08T10:02:00.000Z"))
      const edited = await as(alice).artifacts.update(id, {
        kind: "canvas",
        title: "Onboarding",
        files: await canvas(),
      })
      const atEdited = { artifactId: id, version: 2, updatedAt: edited.version.updatedAt }
      for (const at of [{ ...written, version: 2 }, atEdited]) {
        expect(await store(at)).toMatchObject({ code: "not_allowed" })
      }
    } finally {
      jest.setSystemTime()
    }
  })

  // Guard proof: answer the queries of every run's publish, or of none. A publisher that renders
  // its own previews then runs each query twice, or a command in the sandbox leaves its live
  // boards without a preview.
  test("answers its queries for previews only when it does not render them itself", async () => {
    const { deps, runSdk, artifacts, canvas } = await setup()
    const query = spyOn(runSdk.artifacts, "query")
    const files = () =>
      canvas({ "queries/tasks.json": JSON.stringify({ kind: "start", objectTypeId: Task.id }) })
    const claim = async () =>
      (
        await deps.queues.agents.claim({
          projectId,
          workerId: "test",
          limit: 10,
          leaseMs: 3_600_000,
        })
      )[0]?.job

    // The publish tool, whose layout check reads the answers and pictures the boards.
    const checked = await artifacts.publish({
      kind: "canvas",
      title: "Tasks",
      files: await files(),
      rendersPreviews: true,
    })
    expect(query).not.toHaveBeenCalled()

    // A command in the sandbox, which publishes through the API with the run's token.
    const commanded = await artifacts.publish({
      kind: "canvas",
      title: "Tasks",
      files: await files(),
    })
    expect(query).toHaveBeenCalledTimes(1)
    const job = await claim()
    expect(job).toMatchObject({
      type: "agent.artifact-previews.requested",
      payload: {
        artifactId: commanded.artifact.id,
        version: 1,
        updatedAt: commanded.version.updatedAt.toISOString(),
        queries: { blobId: expect.any(String) },
      },
    })

    // The publish tool's job waits out the check's grace, and carries no answers.
    expect(await claim()).toBeUndefined()
    jest.useFakeTimers()
    jest.setSystemTime(new Date(Date.now() + BOARD_PREVIEW_JOB.graceMs))
    const waited = await claim()
    expect(waited?.payload).toEqual({
      artifactId: checked.artifact.id,
      version: 1,
      updatedAt: checked.version.updatedAt.toISOString(),
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
