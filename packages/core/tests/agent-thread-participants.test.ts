import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import { createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "agent-thread-participants"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: projectId,
    ontology: [],
    models: { language: [testLanguageModel()] },
    ...deps,
  })
  return { host, storage: deps.storage }
}

type Host = ReturnType<typeof setup>["host"]

/** A signed-in user's request, as the server binds one. */
async function signedIn(host: Host, id: string, grants = { "run:agent": true }) {
  await host.storage.auth?.users.create({
    projectId,
    id,
    email: `${id}@example.com`,
    displayName: id.replace("usr_", ""),
  })

  const sessionId = `session-${id}`
  await host.storage.auth?.sessions.create({
    projectId,
    id: sessionId,
    userId: id,
    strategyId: "test",
    tokenHash: sessionId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  })

  return bindRequestExecution(host, {
    request: new Request("http://localhost/test"),
    authorization: {
      type: "principal",
      credential: { type: "session", id: sessionId },
      context: {
        principal: { type: "user", id },
        sessionId,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), ...grants },
      },
    },
  })
}

/** Alice's thread with one finished turn, shared with Bob through storage. */
async function sharedThread(host: Host) {
  const owner = await signedIn(host, alice.id)
  const participant = await signedIn(host, bob.id)
  const other = await signedIn(host, "usr_cleo")

  const thread = await owner.agent.threads.create({ title: "Late deals" })
  const { run } = await owner.agent.runs.request({ threadId: thread.id, text: "Which slipped?" })
  await host.storage.agents?.runs.finishQueued({ projectId, id: run.id, status: "failed" })

  await host.storage.agents?.threads.addParticipants({
    projectId,
    threadId: thread.id,
    principals: [bob],
    addedBy: alice,
    maxParticipants: 50,
    addedAt: new Date("2026-10-20T09:00:00.000Z"),
  })

  return { owner, participant, other, thread, run }
}

describe("reading a shared conversation", () => {
  // Guard proof: return null for "participant" in createAgentThreadAccessRule; Bob then gets
  // null and empty lists everywhere below.
  test("a participant reads the thread, its runs, and finds it shared with them", async () => {
    const { host } = setup()
    const { owner, participant, thread, run } = await sharedThread(host)

    const seen = await participant.agent.threads.getById(thread.id)
    expect(seen).toMatchObject({ id: thread.id, ownerPrincipal: alice })
    expect(seen?.participants).toEqual([
      { principal: bob, addedAt: new Date("2026-10-20T09:00:00.000Z"), addedBy: alice },
    ])
    expect(await owner.agent.threads.getById(thread.id)).toMatchObject({
      participants: [{ principal: bob }],
    })

    expect(await participant.agent.runs.getById(run.id)).toMatchObject({ id: run.id })
    expect((await participant.agent.runs.listForThread(thread.id))?.runs).toHaveLength(1)

    const shared = await participant.agent.threads.list({ sharedWithMe: true })
    expect(shared.threads.map((each) => each.id)).toEqual([thread.id])
    expect(shared.threads[0]?.participants).toHaveLength(1)

    // Bob's own list stays his own; Alice's never holds what was shared with her.
    expect((await participant.agent.threads.list()).total).toBe(0)
    expect((await owner.agent.threads.list()).total).toBe(1)
    expect((await owner.agent.threads.list({ sharedWithMe: true })).total).toBe(0)
  })

  test("anyone else reads nothing, and a participant without can.run(agent) neither", async () => {
    const { host } = setup()
    const { other, thread, run } = await sharedThread(host)

    expect(await other.agent.threads.getById(thread.id)).toBeNull()
    expect(await other.agent.runs.getById(run.id)).toBeNull()
    expect(await other.agent.runs.listForThread(thread.id)).toBeNull()
    expect((await other.agent.threads.list({ sharedWithMe: true })).total).toBe(0)

    const withoutAgent = await signedIn(host, "usr_dan", { "run:agent": false })
    await host.storage.agents?.threads.addParticipants({
      projectId,
      threadId: thread.id,
      principals: [{ type: "user", id: "usr_dan" }],
      addedBy: alice,
      maxParticipants: 50,
    })
    expect(await withoutAgent.agent.threads.getById(thread.id)).toBeNull()
    expect((await withoutAgent.agent.threads.list({ sharedWithMe: true })).total).toBe(0)
  })

  test("a participant talks in the thread with their own rights", async () => {
    const { host, storage } = setup()
    const { participant, other, thread } = await sharedThread(host)

    const { run } = await participant.agent.runs.request({ threadId: thread.id, text: "Why?" })
    const execution = await storage.executions.getById({ projectId, id: run.executionId })
    expect(execution?.requestedBy).toEqual(bob)
    expect(run.requestedBy).toEqual(bob)

    const { messages } = await storage.agents.messages.list({ projectId, threadId: thread.id })
    expect(messages.at(-1)).toMatchObject({ role: "user", authorPrincipal: bob })

    // One turn at a time, whoever asks.
    await expect(
      participant.agent.runs.request({ threadId: thread.id, text: "And?" })
    ).rejects.toMatchObject({ code: "active_run_exists" })
    await expect(
      other.agent.runs.request({ threadId: thread.id, text: "Me too" })
    ).rejects.toMatchObject({ code: "thread_not_found" })
  })

  test("code without a caller reads every thread and has none shared with it", async () => {
    const { host } = setup()
    const { thread } = await sharedThread(host)
    const system = createTestSixb(host)

    expect(await system.agent.threads.getById(thread.id)).toMatchObject({
      participants: [{ principal: bob }],
    })
    expect((await system.agent.threads.list()).total).toBe(1)
    expect((await system.agent.threads.list({ sharedWithMe: true })).total).toBe(0)
  })
})
