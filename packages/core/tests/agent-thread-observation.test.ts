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
  // Guard proof: return every version from conversationVersions, unfiltered; the observer then
  // reads version 1, which no conversation published, and counts it.
  test("reads only what the Agent published in a conversation, counted alone", async () => {
    const { deps, owner, observer, activityOnly } = setup()
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

    // Version 1 comes from code; 2 and 3 from a conversation, as the Agent's tool stores them.
    const { artifact, version: first } = await owner.artifacts.create(content)
    const { projectId: _projectId, artifactId: _artifactId, version: _number, ...input } = first
    for (const title of ["Late invoices, v2", "Late invoices, v3"]) {
      await deps.storage.artifacts.publish({
        projectId,
        artifactId: artifact.id,
        kind: "document",
        version: { ...input, title, origin: { threadId: "thr_marie", runId: "run_marie" } },
      })
    }

    const observed = observer.agent.observed.artifacts
    expect(await observed.get(artifact.id)).toMatchObject({
      latestVersion: 3,
      title: "Late invoices, v3",
    })
    expect(await observed.getVersion(artifact.id, "latest")).toMatchObject({ version: 3 })
    expect(await observed.getVersion(artifact.id, 1)).toBeNull()
    expect(await observed.listVersions(artifact.id, { limit: 1 })).toMatchObject({
      versions: [{ version: 3 }],
      hasMore: true,
      total: 2,
    })
    expect(await observed.listVersions(artifact.id, { limit: 1, offset: 1 })).toMatchObject({
      versions: [{ version: 2 }],
      hasMore: false,
      total: 2,
    })

    // sixb.artifacts stays the caller's own.
    expect(await observer.artifacts.get(artifact.id)).toBeNull()
    expect(await observer.artifacts.getVersion(artifact.id, 2)).toBeNull()
    await expect(activityOnly.agent.observed.artifacts.get(artifact.id)).rejects.toThrow(
      AuthorizationError
    )
    await expect(activityOnly.agent.observed.artifacts.getVersion(artifact.id, 2)).rejects.toThrow(
      AuthorizationError
    )
  })

  // Guard proof: return the stored record (`read.artifact`) unchanged from `get`; it then names
  // version 3, which the observer cannot read, under a title no conversation showed.
  test("a version published from code later leaves the conversation's artifact readable", async () => {
    const { deps, owner, observer } = setup()
    const file = await deps.blobStorage.put({
      body: new TextEncoder().encode("# Late invoices"),
      fileName: "document.md",
    })
    const content = {
      kind: "document" as const,
      title: "Late invoices",
      files: [{ path: "document.md", file }],
    }
    const { artifact, version: first } = await owner.artifacts.create(content)
    const { projectId: _projectId, artifactId: _artifactId, version: _number, ...input } = first
    await deps.storage.artifacts.publish({
      projectId,
      artifactId: artifact.id,
      kind: "document",
      version: { ...input, origin: { threadId: "thr_marie", runId: "run_marie" } },
    })
    await owner.artifacts.publish(artifact.id, { ...content, title: "Edited from code" })

    const observed = observer.agent.observed.artifacts
    const record = await observed.get(artifact.id)
    expect(record).toMatchObject({ latestVersion: 2, title: "Late invoices" })
    expect(await observed.getVersion(artifact.id, record?.latestVersion ?? 0)).not.toBeNull()
    expect(await observed.getVersion(artifact.id, 3)).toBeNull()
    expect(JSON.stringify(await observed.listVersions(artifact.id))).not.toContain(
      "Edited from code"
    )
  })
})
