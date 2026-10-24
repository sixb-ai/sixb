import { describe, expect, test } from "bun:test"
import {
  agent,
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  prop,
  SixbHost,
} from "../src"
import { emptyGrantIndex } from "../src/authorization"
import { bindRequestExecution } from "../src/execution/request"
import { createTestSixb } from "../src/testing"
import { testLanguageModel } from "./helpers/language-model"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const projectId = "agent-thread-participants"
const alice = { type: "user", id: "usr_alice" } as const
const bob = { type: "user", id: "usr_bob" } as const

const financial = defineMarking("financial")
const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("amount", "double", { markings: [financial] }),
  ],
})

const agentUsers = defineGroup("agent-users")
const agentRunner = defineRole("agent.runner", {
  grantedTo: [agentUsers],
  grants: [can.run(agent)],
})

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: projectId,
    ontology: [Invoice],
    markings: [financial],
    models: { language: [testLanguageModel()] },
    groups: [agentUsers],
    roles: [agentRunner],
    ...deps,
  })
  return { host, storage: deps.storage }
}

type Host = ReturnType<typeof setup>["host"]

/** A signed-in user's request, as the server binds one. */
async function signedIn(
  host: Host,
  id: string,
  grants: Partial<ReturnType<typeof emptyGrantIndex>> = { "run:agent": true },
  clearances?: readonly string[]
) {
  await host.storage.auth?.users.create({
    projectId,
    id,
    email: `${id}@example.com`,
    displayName: id.replace("usr_", ""),
  })
  // Through the project's roles too, as adding a participant checks them.
  if (grants["run:agent"]) {
    await host.storage.auth?.groupMemberships.upsert({
      projectId,
      userId: id,
      groupId: agentUsers.id,
      source: "manual",
    })
  }

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
        ...(clearances ? { clearances: new Set(clearances) } : {}),
      },
    },
  })
}

type Grants = Partial<ReturnType<typeof emptyGrantIndex>>

/**
 * Alice's thread with one finished turn, shared with Bob through storage. Each may read objects
 * with more than the Agent's grant.
 */
async function sharedThread(
  host: Host,
  reads: { readonly owner?: Grants; readonly participant?: Grants; readonly cleared?: true } = {}
) {
  const owner = await signedIn(
    host,
    alice.id,
    { "run:agent": true, ...reads.owner },
    reads.cleared ? [financial.id] : undefined
  )
  const participant = await signedIn(host, bob.id, { "run:agent": true, ...reads.participant })
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

describe("adding and removing participants", () => {
  // Guard proof: drop the `access !== "owner"` check in requireOwnedThread; Bob then adds Cleo.
  test("only the owner adds active users, once each", async () => {
    const { host } = setup()
    const owner = await signedIn(host, alice.id)
    const participant = await signedIn(host, bob.id)
    const other = await signedIn(host, "usr_cleo")
    const thread = await owner.agent.threads.create({ title: "Late deals" })

    const shared = await owner.agent.threads.participants.add(thread.id, [bob, bob])
    expect(shared.participants).toMatchObject([{ principal: bob, addedBy: alice }])

    const again = await owner.agent.threads.participants.add(thread.id, [bob])
    expect(again.participants).toEqual(shared.participants)

    await expect(
      participant.agent.threads.participants.add(thread.id, [{ type: "user", id: "usr_cleo" }])
    ).rejects.toMatchObject({ code: "not_thread_owner" })
    await expect(
      other.agent.threads.participants.add(thread.id, [{ type: "user", id: "usr_cleo" }])
    ).rejects.toMatchObject({ code: "thread_not_found" })
  })

  test("refuses the owner, unknown or suspended users, and anything but a user", async () => {
    const { host } = setup()
    const owner = await signedIn(host, alice.id)
    await host.storage.auth?.users.create({
      projectId,
      id: "usr_gone",
      email: "gone@example.com",
      status: "suspended",
    })
    const thread = await owner.agent.threads.create({})
    const add = (users: readonly { type: "user"; id: string }[]) =>
      owner.agent.threads.participants.add(thread.id, users)

    await expect(add([alice])).rejects.toMatchObject({ code: "invalid_participant" })
    await expect(add([{ type: "user", id: "usr_nobody" }])).rejects.toMatchObject({
      code: "invalid_participant",
      message:
        "[Sixb] Agent thread participant references user 'usr_nobody', which does not exist.",
    })
    await expect(add([{ type: "user", id: "usr_gone" }])).rejects.toMatchObject({
      code: "invalid_participant",
    })
    await expect(
      add([{ type: "serviceAccount", id: "svc_bot" } as unknown as { type: "user"; id: string }])
    ).rejects.toMatchObject({ code: "invalid_participant" })
    await expect(add([])).rejects.toMatchObject({ code: "invalid_participant" })

    // Guard proof: drop the userCanRunAgent check in activeUsers; Dan is then added, though he
    // could never read the thread.
    await signedIn(host, "usr_dan", { "run:agent": false })
    await expect(add([{ type: "user", id: "usr_dan" }])).rejects.toMatchObject({
      code: "invalid_participant",
      message:
        "[Sixb] User 'usr_dan' cannot use the Agent: a role granting can.run(agent) must reach them first.",
    })

    expect((await owner.agent.threads.getById(thread.id))?.participants).toEqual([])
  })

  // Guard proof: look emails up with getById in activeUsers; Bob's email then names no user.
  test("adds users by email, refused in the words an id is", async () => {
    const { host } = setup()
    const owner = await signedIn(host, alice.id)
    await signedIn(host, bob.id)
    await host.storage.auth?.users.create({
      projectId,
      id: "usr_gone",
      email: "gone@example.com",
      status: "suspended",
    })
    const thread = await owner.agent.threads.create({})
    const add = (users: Parameters<typeof owner.agent.threads.participants.add>[1]) =>
      owner.agent.threads.participants.add(thread.id, users)

    const shared = await add([{ email: " USR_BOB@example.com " }, bob])
    expect(shared.participants.map((participant) => participant.principal)).toEqual([bob])

    await expect(add([{ email: "nobody@example.com" }])).rejects.toMatchObject({
      code: "invalid_participant",
      message:
        "[Sixb] Agent thread participant references user 'nobody@example.com', which does not exist.",
    })
    await expect(add([{ email: "gone@example.com" }])).rejects.toMatchObject({
      code: "invalid_participant",
      message:
        "[Sixb] Agent thread participant references user 'gone@example.com', who is suspended. Only active users can be newly referenced; existing references are kept.",
    })
    await expect(add([{ email: "usr_alice@example.com" }])).rejects.toMatchObject({
      code: "invalid_participant",
      message: "[Sixb] The thread's owner already takes part in it; add other users.",
    })
    await expect(add([{ email: "  " }])).rejects.toMatchObject({ code: "invalid_participant" })
  })

  test("the owner removes anyone, a participant only leaves", async () => {
    const { host } = setup()
    const { owner, participant, other, thread } = await sharedThread(host)
    const dan = { type: "user", id: "usr_dan" } as const
    await signedIn(host, dan.id)
    await owner.agent.threads.participants.add(thread.id, [dan])

    await expect(
      participant.agent.threads.participants.remove(thread.id, dan)
    ).rejects.toMatchObject({ code: "not_thread_owner" })
    await expect(
      participant.agent.threads.participants.remove(thread.id, alice)
    ).rejects.toMatchObject({ code: "invalid_participant" })
    await expect(other.agent.threads.participants.remove(thread.id, bob)).rejects.toMatchObject({
      code: "thread_not_found",
    })

    await participant.agent.threads.participants.remove(thread.id, bob)
    expect(await participant.agent.threads.getById(thread.id)).toBeNull()

    await owner.agent.threads.participants.remove(thread.id, dan)
    await owner.agent.threads.participants.remove(thread.id, dan)
    expect((await owner.agent.threads.getById(thread.id))?.participants).toEqual([])
  })
})

describe("forking a shared conversation", () => {
  // Guard proof: fork only when the caller owns the source; Bob's fork is then refused.
  test("a participant forks it into a thread they own alone", async () => {
    const { host } = setup()
    const { owner, participant, thread } = await sharedThread(host)

    const fork = await participant.agent.threads.fork(thread.id)

    expect(fork).toMatchObject({
      ownerPrincipal: bob,
      title: "Late deals",
      participants: [],
      messageCount: 1,
    })
    expect(
      await host.storage.agents?.threads.listParticipants({ projectId, threadIds: [fork.id] })
    ).toEqual([])
    expect((await participant.agent.threads.list()).threads.map((each) => each.id)).toEqual([
      fork.id,
    ])
    expect(await owner.agent.threads.getById(fork.id)).toBeNull()
    expect((await owner.agent.threads.getById(thread.id))?.participants).toHaveLength(1)
  })

  test("anyone else, an observer, or a removed participant cannot fork it", async () => {
    const { host } = setup()
    const { owner, participant, other, thread } = await sharedThread(host)
    const observer = await signedIn(host, "usr_olivia", {
      "run:agent": true,
      "observe:agentThreads": true,
    })
    expect(await observer.agent.observed.getById(thread.id)).toMatchObject({ id: thread.id })

    await owner.agent.threads.participants.remove(thread.id, bob)

    for (const caller of [other, observer, participant]) {
      await expect(caller.agent.threads.fork(thread.id)).rejects.toMatchObject({
        code: "thread_not_found",
      })
    }
    expect((await host.storage.agents?.threads.list({ projectId }))?.total).toBe(1)
  })
})

describe("stopping and retrying a turn in a shared thread", () => {
  // Guard proof: return the run from getControllableRun whatever its requester; Bob then retries
  // Alice's turn and stops her retry, and Alice retries Bob's turn.
  test("whoever asked for a turn stops or retries it; the owner also stops any", async () => {
    const { host, storage } = setup()
    const { owner, participant, run: alicesTurn, thread } = await sharedThread(host)

    await expect(participant.agent.runs.retry(alicesTurn.id)).rejects.toMatchObject({
      code: "not_run_requester",
    })

    const { run: alicesRetry } = await owner.agent.runs.retry(alicesTurn.id)
    await expect(participant.agent.runs.cancel(alicesRetry.id)).rejects.toMatchObject({
      code: "not_run_requester",
    })
    expect(await owner.agent.runs.cancel(alicesRetry.id)).toMatchObject({ status: "cancelled" })

    // Bob stops his own turn; once it ended, it is no longer active.
    const { run: bobsTurn } = await participant.agent.runs.request({
      threadId: thread.id,
      text: "Why did Acme slip?",
    })
    expect(await participant.agent.runs.cancel(bobsTurn.id)).toMatchObject({
      status: "cancelled",
    })
    await expect(participant.agent.runs.cancel(bobsTurn.id)).rejects.toMatchObject({
      code: "run_not_active",
    })

    // Bob's failed turn is his to retry: the owner's rights must not answer his words.
    const { run: failed } = await participant.agent.runs.request({
      threadId: thread.id,
      text: "And Globex?",
    })
    await storage.agents.runs.finishQueued({ projectId, id: failed.id, status: "failed" })

    await expect(owner.agent.runs.retry(failed.id)).rejects.toMatchObject({
      code: "not_run_requester",
    })
    const { run: retried } = await participant.agent.runs.retry(failed.id)
    expect(retried).toMatchObject({ triggerMessageId: failed.triggerMessageId, requestedBy: bob })
  })
})

describe("a shared thread's sandbox", () => {
  // Guard proof: drop the `access !== "owner"` check in recreateSandbox; Bob then reaches the
  // storage transition, which refuses with an invalid-state error instead.
  test("only the owner recreates it", async () => {
    const { host } = setup()
    const { participant, thread } = await sharedThread(host)

    await expect(
      participant.agent.threads.recreateSandbox(thread.id, { expectedSandboxName: "any" })
    ).rejects.toMatchObject({ code: "not_thread_owner" })
  })
})

describe("artifacts a shared conversation shares", () => {
  async function sharedArtifact(host: Host) {
    const shared = await sharedThread(host)
    const file = await host.blobStorage.put({
      body: new TextEncoder().encode("# Late deals"),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    const content = {
      kind: "document" as const,
      title: "Late deals",
      files: [{ path: "document.md", file }],
    }

    // Alice's report, which the Agent then showed in the thread, and her private notes.
    const { artifact, version: first } = await shared.owner.artifacts.create(content)
    const { projectId: _p, artifactId: _a, version: _v, ...input } = first
    await host.storage.artifacts?.publish({
      projectId,
      artifactId: artifact.id,
      kind: "document",
      version: { ...input, origin: { threadId: shared.thread.id, runId: shared.run.id } },
    })
    const { artifact: notes } = await shared.owner.artifacts.create({ ...content, title: "Notes" })

    return { ...shared, artifact, notes, content }
  }

  // Guard proof: return null for "participant" in createAgentThreadAccessRule; Bob then reaches
  // none of them.
  test("a participant reads and updates them at their latest, and keeps their own page data", async () => {
    const { host } = setup()
    const { owner, participant, thread, artifact, content } = await sharedArtifact(host)

    // The owner's edit from outside the conversation is shared too: the artifact is, whole.
    await owner.artifacts.publish(artifact.id, { ...content, title: "Edited in the app" })
    expect(await participant.artifacts.access(artifact.id)).toBe("update")
    expect(await participant.artifacts.get(artifact.id)).toMatchObject({
      latestVersion: 3,
      title: "Edited in the app",
      owner: alice,
    })

    const saved = await participant.artifacts.publish(artifact.id, {
      ...content,
      title: "Bob's edit",
    })
    expect(saved.version).toMatchObject({ version: 4, author: bob })
    expect(saved.artifact.owner).toEqual(alice)

    await participant.artifacts.state(artifact.id).set("filters", { region: "EMEA" })
    expect(await owner.artifacts.state(artifact.id).get("filters")).toBeUndefined()
    expect(await participant.artifacts.state(artifact.id).get("filters")).toEqual({
      region: "EMEA",
    })

    expect(
      (await participant.artifacts.list({ threadId: thread.id })).artifacts.map((each) => each.id)
    ).toEqual([artifact.id])
    expect(await participant.artifacts.delete(artifact.id)).toBe(false)
    expect(await owner.artifacts.get(artifact.id)).not.toBeNull()
  })

  // Guard proof: check only before validating in ArtifactsRuntime.publish (answer "update" from
  // the access passed to storeArtifactVersion); Bob's version then lands after his removal.
  test("a participant's save shares nothing more, and lands only while they take part", async () => {
    const { host } = setup()
    const { owner, participant, thread, artifact, content } = await sharedArtifact(host)

    // A save in the app has no conversation: it links the artifact nowhere new.
    await participant.artifacts.publish(artifact.id, { ...content, title: "Bob's edit" })
    expect(await host.storage.artifacts?.listThreadIds({ projectId, id: artifact.id })).toEqual([
      thread.id,
    ])

    // Removed while his next version's files are read, Bob publishes nothing.
    const blobs = host.blobStorage
    const open = blobs.open.bind(blobs)
    blobs.open = async (...args) => {
      blobs.open = open
      await owner.agent.threads.participants.remove(thread.id, bob)
      return open(...args)
    }
    await expect(
      participant.artifacts.publish(artifact.id, { ...content, title: "Too late" })
    ).rejects.toMatchObject({ code: "not_shared" })
    expect(await owner.artifacts.get(artifact.id)).toMatchObject({ latestVersion: 3 })
  })

  test("nobody else reaches them, nor the owner's artifacts the conversation does not share", async () => {
    const { host } = setup()
    const { participant, other, thread, artifact, notes, content } = await sharedArtifact(host)

    expect(await participant.artifacts.access(notes.id)).toBe("none")
    expect(await participant.artifacts.get(notes.id)).toBeNull()
    await expect(participant.artifacts.publish(notes.id, content)).rejects.toMatchObject({
      code: "not_shared",
    })

    // Guard proof: let `readable` accept any artifact in publish; Bob's version then embeds
    // Alice's notes.
    const embedding = await host.blobStorage.put({
      body: new TextEncoder().encode(`# Late deals\n\n![Notes](artifact:${notes.id})\n`),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    await expect(
      participant.artifacts.publish(artifact.id, {
        ...content,
        files: [{ path: "document.md", file: embedding }],
      })
    ).rejects.toThrow("names no artifact you can read")

    expect(await other.artifacts.access(artifact.id)).toBe("none")
    expect((await other.artifacts.list({ threadId: thread.id })).total).toBe(0)

    // Removed, Bob reaches none of it any more.
    await participant.agent.threads.participants.remove(thread.id, bob)
    expect(await participant.artifacts.get(artifact.id)).toBeNull()
  })

  // Guard proof: let `sharing` in createRuntimeArtifactAccessRule allow any credential but an
  // access token; Bob without a credential then reads Alice's artifact. Drop the check entirely,
  // and his token reads it too.
  test("only a session reaches what is shared: an access token or no credential reach their own", async () => {
    const { host } = setup()
    const { artifact } = await sharedArtifact(host)
    const token = bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "accessToken", id: "pat_bob" },
        context: {
          principal: bob,
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:agent": true },
        },
      },
    })

    expect(await token.artifacts.access(artifact.id)).toBe("none")
    expect(await token.artifacts.get(artifact.id)).toBeNull()

    const withoutCredential = createTestSixb(host, {
      authorization: {
        principal: bob,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    })
    expect(await withoutCredential.artifacts.access(artifact.id)).toBe("none")
  })

  // Guard proofs: return no copies from copySharedArtifacts, and the fork's messages name Alice's
  // artifact, which Bob loses once removed from her thread; copy only the latest version, and the
  // copy has no version 2 for the card nor 1 for the pinned embed.
  test("a fork gets its own copies, with their history, and its messages name them", async () => {
    const { host } = setup()
    const { owner, participant, thread, run, artifact, content } = await sharedArtifact(host)
    await owner.artifacts.publish(artifact.id, { ...content, title: "Latest" })
    // A card for version 2, as publish_artifact_version leaves one, and an embed pinned to @1.
    await host.storage.agents?.messages.append({
      projectId,
      id: "msg_shown",
      threadId: thread.id,
      runId: run.id,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          toolCallId: "call_publish",
          toolName: "publish_artifact_version",
          input: { id: artifact.id },
          state: "output-available",
          output: { artifactId: artifact.id, version: 2 },
        },
        { type: "text", text: `As it was: ![Deals](artifact:${artifact.id}@1)` },
      ],
    })

    const fork = await participant.agent.threads.fork(thread.id)
    const copies = await participant.artifacts.list({ threadId: fork.id })
    expect(copies.artifacts).toHaveLength(1)
    const [copy] = copies.artifacts
    if (!copy) throw new Error("Expected the fork's copy.")
    expect(copy).toMatchObject({ owner: bob, title: "Latest", latestVersion: 3 })
    expect(copy.id).not.toBe(artifact.id)

    const { messages } = (await host.storage.agents?.messages.list({
      projectId,
      threadId: fork.id,
    })) ?? { messages: [] }
    const copied = JSON.stringify(messages)
    expect(copied).toContain(`"artifactId":"${copy.id}","version":2`)
    expect(copied).toContain(`artifact:${copy.id}@1`)
    expect(copied).not.toContain(artifact.id)

    // What they name is there, as it was.
    const original = await owner.artifacts.listVersions(artifact.id)
    const history = await participant.artifacts.listVersions(copy.id)
    expect(
      history?.versions.map(({ version, title, author }) => ({ version, title, author }))
    ).toEqual(original?.versions.map(({ version, title, author }) => ({ version, title, author })))
    expect(await participant.artifacts.getVersion(copy.id, 2)).toMatchObject({
      title: "Late deals",
    })

    // The copy is Bob's: it stays when he leaves Alice's thread, and the original stays hers.
    await participant.agent.threads.participants.remove(thread.id, bob)
    expect(await participant.artifacts.access(copy.id)).toBe("owner")
    expect(await owner.artifacts.get(artifact.id)).toMatchObject({ latestVersion: 3 })
  })

  // Guard proof: copy every artifact the source shares in copySharedArtifacts, whatever the
  // caller reaches; Bob's token then copies Alice's artifact into his own.
  test("a fork through an access token copies only the caller's own artifacts", async () => {
    const { host } = setup()
    const { thread } = await sharedArtifact(host)
    const token = bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "accessToken", id: "pat_bob" },
        context: {
          principal: bob,
          groupIds: [],
          roleIds: [],
          grants: { ...emptyGrantIndex(), "run:agent": true },
        },
      },
    })

    const fork = await token.agent.threads.fork(thread.id)
    expect((await host.storage.artifacts?.list({ projectId, threadId: fork.id }))?.total).toBe(0)
  })

  test("a fork that fails leaves no copy behind", async () => {
    const { host } = setup()
    const { participant, thread, artifact } = await sharedArtifact(host)
    const agents = host.storage.agents
    if (!agents) throw new Error("Expected agent storage.")
    const fork = agents.threads.fork.bind(agents.threads)
    agents.threads.fork = async () => {
      throw new Error("storage went away")
    }

    try {
      await expect(participant.agent.threads.fork(thread.id)).rejects.toThrow("storage went away")
    } finally {
      agents.threads.fork = fork
    }
    // Alice's report and notes, and no copy.
    expect((await host.storage.artifacts?.list({ projectId }))?.total).toBe(2)
    expect(await participant.artifacts.get(artifact.id)).not.toBeNull()
  })
})

describe("queries in the artifacts a conversation shares", () => {
  // Guard proof: read the artifact from storage in `readVersion`, not through `getReadable`; Cleo
  // then runs Alice's query.
  test("each reader runs them with their own rights", async () => {
    const { host } = setup()
    const invoices: Grants = { "view:object": new Set([Invoice.id]) }
    const { owner, participant, other, thread, run } = await sharedThread(host, {
      owner: invoices,
      participant: invoices,
      cleared: true,
    })
    const observer = await signedIn(host, "usr_olivia", {
      ...invoices,
      "observe:agentThreads": true,
    })
    await createTestSixb(host)
      .objects(Invoice)
      .upsert({ properties: { id: "inv_1", amount: 1200 } })

    const put = async (path: string, text: string) => ({
      path,
      file: await host.blobStorage.put({ body: new TextEncoder().encode(text), fileName: path }),
    })
    const { artifact, version } = await owner.artifacts.create({
      kind: "page",
      title: "Invoices",
      files: [
        await put("index.html", "<!doctype html><title>Invoices</title><p>Invoices</p>"),
        await put("queries/invoices.json", '{"kind":"start","objectTypeId":"Invoice"}'),
      ],
    })
    // As the Agent shows it in the thread.
    const { projectId: _p, artifactId: _a, version: _v, ...input } = version
    await host.storage.artifacts?.publish({
      projectId,
      artifactId: artifact.id,
      kind: "page",
      version: { ...input, origin: { threadId: thread.id, runId: run.id } },
    })

    const rowOf = async (reader: typeof owner) => {
      const result = await reader.artifacts.query(artifact.id, "invoices")
      if (result?.kind !== "objects") throw new Error("Expected the query's rows.")
      return result.objects[0]
    }

    expect(await rowOf(owner)).toMatchObject({ properties: { id: "inv_1", amount: 1200 } })
    expect(await rowOf(owner)).not.toHaveProperty("redactions")

    // Bob takes part without the clearance: the row, without its amount.
    const bobs = await rowOf(participant)
    expect(bobs).toMatchObject({
      properties: { id: "inv_1" },
      redactions: { amount: { reason: "missing_clearance" } },
    })
    expect(bobs?.properties).not.toHaveProperty("amount")

    expect(await rowOf(observer)).toMatchObject({ properties: { id: "inv_1" } })
    expect(await other.artifacts.query(artifact.id, "invoices")).toBeNull()
  })

  // Guard proof: drop the assertReturnsReadable call from createArtifactQueryChecker; Bob's first
  // version then publishes, and the owner's rows reach his page with their amount.
  test("a participant's version returns only what they can read, whoever reads it", async () => {
    const { host } = setup()
    const invoices: Grants = { "view:object": new Set([Invoice.id]) }
    const { owner, participant, thread, run } = await sharedThread(host, {
      owner: invoices,
      participant: invoices,
      cleared: true,
    })
    await createTestSixb(host)
      .objects(Invoice)
      .upsert({ properties: { id: "inv_1", amount: 1200 } })

    const put = async (path: string, text: string) => ({
      path,
      file: await host.blobStorage.put({ body: new TextEncoder().encode(text), fileName: path }),
    })
    const index = await put("index.html", "<!doctype html><title>Invoices</title><p>Invoices</p>")

    // Alice's page, which the Agent then showed in the thread.
    const { artifact, version } = await owner.artifacts.create({
      kind: "page",
      title: "Invoices",
      files: [index],
    })
    const { projectId: _p, artifactId: _a, version: _v, ...input } = version
    await host.storage.artifacts?.publish({
      projectId,
      artifactId: artifact.id,
      kind: "page",
      version: { ...input, origin: { threadId: thread.id, runId: run.id } },
    })

    // Bob is not cleared for amounts: a query that returns them is his to leave out.
    const all = await put("queries/invoices.json", '{"kind":"start","objectTypeId":"Invoice"}')
    const refused = await participant.artifacts
      .publish(artifact.id, { kind: "page", title: "Invoices", files: [index, all] })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({
      code: "invalid_artifact",
      message:
        "[Sixb] queries/invoices.json: $: returns 'amount' on 'Invoice', which you are not cleared to read: add a \"project\" node that lists only the properties you can read.",
    })

    const ids = await put(
      "queries/invoices.json",
      '{"kind":"project","input":{"kind":"start","objectTypeId":"Invoice"},"properties":["id"]}'
    )
    await participant.artifacts.publish(artifact.id, {
      kind: "page",
      title: "Invoices",
      files: [index, ids],
    })

    // Alice is cleared, and his page still gets only what he could read.
    const rows = await owner.artifacts.query(artifact.id, "invoices")
    expect(rows?.kind === "objects" && rows.objects[0]?.properties).toEqual({ id: "inv_1" })
  })
})
