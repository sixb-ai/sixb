import { describe, expect, test } from "bun:test"
import { AgentRequestError, AuthorizationError, SixbHost } from "../src"
import { emptyGrantIndex, type GrantIndex } from "../src/authorization/types"
import { createTestAgentExecution, createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "agent-thread-observation"

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [testLanguageModel()] },
    ...deps,
  })

  const as = (id: string, grants: Partial<GrantIndex> = {}) =>
    createTestSixb(host, {
      authorization: {
        principal: { type: "user", id },
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true, ...grants },
      },
    })

  return {
    host,
    deps,
    owner: as("marie"),
    observer: as("olivia", { "observe:agentThreads": true }),
    activityOnly: as("arthur", { "observe:activity": true }),
  }
}

async function seedConversation(storage: ReturnType<typeof createTestRuntimeDeps>["storage"]) {
  const thread = await storage.agents.threads.create({
    projectId,
    id: "thr_marie",
    ownerPrincipal: { type: "user", id: "marie" },
    title: "Overdue invoices",
  })
  const message = await storage.agents.messages.append({
    projectId,
    id: "msg_marie",
    threadId: thread.id,
    runId: null,
    role: "user",
    authorPrincipal: { type: "user", id: "marie" },
    parts: [{ type: "text", text: "Which invoices are late?" }],
  })
  const executionId = await createTestAgentExecution(storage, { projectId, runId: "run_marie" })
  await storage.agents.runs.create({
    projectId,
    id: "run_marie",
    threadId: thread.id,
    executionId,
    triggerMessageId: message.id,
    spec: { model: { provider: "test", modelId: "test-model" } },
  })
  await storage.agents.runs.finishQueued({ projectId, id: "run_marie", status: "failed" })
  return thread
}

describe("observing other users' conversations", () => {
  // Guard proof: drop the assertAuthorized call in createObservedAgentThreadsRuntime; the
  // activity-only viewer then reads the thread.
  test("takes can.observe(agent.threads), and reads the thread and its runs", async () => {
    const { deps, owner, observer, activityOnly } = setup()
    const thread = await seedConversation(deps.storage)

    expect(await observer.agent.observed.getById(thread.id)).toMatchObject({
      id: thread.id,
      ownerPrincipal: { type: "user", id: "marie" },
      title: "Overdue invoices",
    })
    const runs = await observer.agent.observed.listRuns(thread.id)
    expect(runs?.runs.map((run) => [run.id, run.status])).toEqual([["run_marie", "failed"]])
    expect(await observer.agent.observed.getById("thr_missing")).toBeNull()
    expect(await observer.agent.observed.listRuns("thr_missing")).toBeNull()

    for (const reader of [activityOnly, owner]) {
      await expect(reader.agent.observed.getById(thread.id)).rejects.toThrow(AuthorizationError)
      await expect(reader.agent.observed.listRuns(thread.id)).rejects.toThrow(
        "not allowed to observe other users' Agent conversations"
      )
    }
  })

  // Guard proof: make getVisibleThreadRecord accept `observe:agentThreads`; the observer then
  // finds the thread in its own list and can post to it.
  test("leaves the owner path as it was: an observer neither lists, posts to nor retries", async () => {
    const { deps, owner, observer } = setup()
    const thread = await seedConversation(deps.storage)

    expect(await owner.agent.threads.getById(thread.id)).toMatchObject({ id: thread.id })
    expect((await owner.agent.threads.list()).total).toBe(1)
    expect((await owner.agent.runs.listForThread(thread.id))?.runs).toHaveLength(1)

    expect(await observer.agent.threads.getById(thread.id)).toBeNull()
    expect((await observer.agent.threads.list()).total).toBe(0)
    expect(await observer.agent.runs.getById("run_marie")).toBeNull()
    expect(await observer.agent.runs.listForThread(thread.id)).toBeNull()

    await expect(
      observer.agent.runs.request({ threadId: thread.id, text: "Let me answer" })
    ).rejects.toBeInstanceOf(AgentRequestError)
    await expect(observer.agent.runs.retry("run_marie")).rejects.toBeInstanceOf(AgentRequestError)
    expect(
      (await deps.storage.agents.messages.list({ projectId, threadId: thread.id })).total
    ).toBe(1)
  })
})

describe("an observer and artifacts", () => {
  // Guard proof: return "update" for an observer in createArtifactsRuntime's conversation rule;
  // the observer then publishes a version and keeps page data.
  test("reads every version of what a conversation shares, read-only", async () => {
    const { deps, owner, observer, activityOnly } = setup()
    await seedConversation(deps.storage)
    const file = await deps.blobStorage.put({
      body: new TextEncoder().encode("# Late invoices"),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    const content = {
      kind: "document" as const,
      title: "Late invoices",
      files: [{ path: "document.md", file }],
    }

    // Version 1 comes from code, 2 from the conversation, 3 from code again.
    const { artifact, version: first } = await owner.artifacts.create(content)
    const { projectId: _projectId, artifactId: _artifactId, version: _number, ...input } = first
    await deps.storage.artifacts.publish({
      projectId,
      artifactId: artifact.id,
      kind: "document",
      version: {
        ...input,
        title: "Late invoices, v2",
        origin: { threadId: "thr_marie", runId: "run_marie" },
      },
    })
    await owner.artifacts.publish(artifact.id, { ...content, title: "Edited from code" })

    expect(await observer.artifacts.access(artifact.id)).toBe("read")
    expect(await observer.artifacts.get(artifact.id)).toMatchObject({
      latestVersion: 3,
      title: "Edited from code",
    })
    expect(await observer.artifacts.getVersion(artifact.id, 1)).toMatchObject({ version: 1 })
    expect((await observer.artifacts.listVersions(artifact.id))?.total).toBe(3)

    await expect(observer.artifacts.publish(artifact.id, content)).rejects.toMatchObject({
      code: "read_only",
    })
    await expect(observer.artifacts.state(artifact.id).get("filters")).rejects.toMatchObject({
      code: "read_only",
    })
    expect(await observer.artifacts.delete(artifact.id)).toBe(false)

    // Without the grant, the conversation's artifacts stay its readers'.
    expect(await activityOnly.artifacts.access(artifact.id)).toBe("none")
    expect(await activityOnly.artifacts.get(artifact.id)).toBeNull()
  })

  test("reaches nothing a conversation does not share", async () => {
    const { deps, owner, observer } = setup()
    await seedConversation(deps.storage)
    const file = await deps.blobStorage.put({
      body: new TextEncoder().encode("# Private"),
      fileName: "document.md",
    })
    const { artifact } = await owner.artifacts.create({
      kind: "document",
      title: "Private",
      files: [{ path: "document.md", file }],
    })

    expect(await observer.artifacts.access(artifact.id)).toBe("none")
    expect(await observer.artifacts.get(artifact.id)).toBeNull()
    expect(await observer.artifacts.access("art_0000000000")).toBeNull()
    expect(
      (await observer.artifacts.list({ threadId: "thr_marie" })).artifacts.map((each) => each.id)
    ).toEqual([])
  })
})
