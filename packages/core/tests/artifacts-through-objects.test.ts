import { describe, expect, spyOn, test } from "bun:test"
import {
  ArtifactRequestError,
  artifactRef,
  can,
  col,
  type DatasetDefinition,
  defineDataset,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { bindRequestExecution } from "../src/execution/request"
import { getAppliedMarkings } from "../src/security/applied-markings-host"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// The objects that hold an artifact are a third way to reach it, beside its owner and the
// conversations that share it. The access rule decides it once for every surface; these tests
// prove it through the artifacts runtime, which the routes, live rooms and events all ask.

const PROJECT = "artifacts-through-objects"
const confidential = defineMarking("confidential")

const meetingProperties = [
  prop("id", "string", { primary: true, required: true }),
  prop("title", "string"),
  prop("status", "string", { query: { searchable: true, filterable: true } }),
  prop("minutes", ref.artifact(), { nullable: true, markings: [confidential] }),
]

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [...meetingProperties, prop("kickoffDoc", ref.artifact(), { nullable: true })],
  search: { title: "title" },
})

/** The same type once `kickoffDoc` is gone from the code, while objects still hold its values. */
const MeetingWithoutKickoff = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: meetingProperties,
})

/** What a meeting's artifact could be put in elsewhere. */
const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("doc", ref.artifact(), { nullable: true }),
  ],
})

const readers = defineGroup("meeting-readers")
const editors = defineGroup("meeting-editors")
const openOnly = defineGroup("open-meetings")
const cleared = defineGroup("cleared")
const taskEditors = defineGroup("task-editors")

const security = {
  markings: [confidential],
  groups: [readers, editors, openOnly, cleared, taskEditors],
  roles: [
    defineRole("meeting-reader", { grantedTo: [readers, cleared], grants: [can.view(Meeting)] }),
    defineRole("meeting-editor", {
      grantedTo: [editors],
      grants: [can.view(Meeting), can.edit(Meeting)],
    }),
    defineRole("open-meeting-reader", {
      grantedTo: [openOnly],
      grants: [can.view(Meeting).where((meeting) => meeting.p.status.eq("open"))],
    }),
    defineRole("confidential-reader", { grantedTo: [cleared], clearances: [confidential] }),
    defineRole("task-editor", {
      grantedTo: [taskEditors],
      grants: [can.view(Task), can.edit(Task)],
    }),
  ],
}

/** A dataset whose column is confidential: what projections apply may mark what readers see. */
const budgets = defineDataset("budgets", {
  schema: [col("id", "string"), col("amount", "decimal", { markings: [confidential] })],
})

async function setup(options: { readonly datasets?: readonly DatasetDefinition[] } = {}) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: PROJECT,
    ontology: [Meeting, Task],
    ...(options.datasets ? { datasets: [...options.datasets] } : {}),
    ...security,
    ...deps,
  })
  const system = createTestSixb(host)

  /** A person in these groups, signed in with a session unless `credential` says otherwise. */
  const as = (
    id: string,
    groupIds: readonly string[] = [],
    credential: "session" | "accessToken" = "session",
    on: SixbHost = host
  ) => {
    const context = resolveAuthorizationContext({
      principal: { type: "user", id },
      ...(credential === "session" ? { sessionId: `session-${id}` } : {}),
      groupIds,
      roles: on.definitions.security.listResolvedRoles(),
    })

    return bindRequestExecution(on, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: credential, id: `${credential}-${id}` },
        context: { ...context, grants: { ...context.grants, "run:agent": true } },
      },
    })
  }

  const alice = as("alice")
  const bob = as("bob", [readers.id])
  const carol = as("carol", [editors.id])
  const dave = as("dave")

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

  /** A document Alice owns, which nothing shares yet. */
  const doc = async (title = "Kick-off") =>
    (await alice.artifacts.create({ kind: "document", title, files: await document("# Plan\n") }))
      .artifact.id

  const meetings = system.objects(Meeting)
  return { deps, host, system, as, alice, bob, carol, dave, document, doc, meetings }
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  return error instanceof ArtifactRequestError ? error.code : undefined
}

describe("an artifact an object holds", () => {
  // Guard proof: answer `null` from the `holders` source in artifacts/execution.ts; Bob and Carol
  // then reach nothing.
  test("is read by whoever reads the object, and updated by whoever may edit it", async () => {
    const { alice, bob, carol, dave, document, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })

    expect(await alice.artifacts.access(kickoff)).toBe("owner")
    expect(await bob.artifacts.access(kickoff)).toBe("read")
    expect(await carol.artifacts.access(kickoff)).toBe("update")
    expect(await dave.artifacts.access(kickoff)).toBe("none")

    // Bob reads every version, and changes nothing.
    expect(await bob.artifacts.get(kickoff)).toMatchObject({ id: kickoff })
    expect(await bob.artifacts.getVersion(kickoff, "latest")).toMatchObject({ version: 1 })
    expect((await bob.artifacts.listVersions(kickoff))?.versions).toHaveLength(1)
    const content = { kind: "document" as const, title: "Kick-off", files: await document("# B") }
    expect(await refusal(bob.artifacts.update(kickoff, content))).toBe("read_only")
    expect(await refusal(bob.artifacts.freeze(kickoff))).toBe("read_only")

    // Carol writes it and creates a version; only Alice deletes it.
    const written = await carol.artifacts.update(kickoff, {
      ...content,
      files: await document("# C"),
    })
    expect(written.version).toMatchObject({ author: { type: "user", id: "carol" }, revision: 2 })
    expect((await carol.artifacts.freeze(kickoff)).version.frozenAt).toBeDefined()
    expect(await carol.artifacts.delete(kickoff)).toBe(false)
    expect(await dave.artifacts.get(kickoff)).toBeNull()

    // The gallery lists what is owned or shared in a conversation: one an object holds is
    // opened from that object.
    expect((await bob.artifacts.list()).total).toBe(0)
    expect((await carol.artifacts.list()).total).toBe(0)
  })

  // Guard proof: read the holders' objects through `runtime.storage.objects` in readableHoldings
  // instead of the caller's reader; Erin and Bob then read what they cannot see.
  test("reaches only through an object and a property the reader sees", async () => {
    const { as, bob, doc, meetings } = await setup()
    const kickoff = await doc()
    const minutes = await doc("Minutes")
    await meetings.upsert({
      properties: { id: "m1", status: "draft", kickoffDoc: artifactRef(kickoff) },
    })
    await meetings.upsert({ properties: { id: "m2", minutes: artifactRef(minutes) } })

    // Erin reads open meetings only, as they are now.
    const erin = as("erin", [openOnly.id])
    expect(await erin.artifacts.access(kickoff)).toBe("none")
    await meetings.upsert({
      properties: { id: "m1", status: "open", kickoffDoc: artifactRef(kickoff) },
    })
    expect(await erin.artifacts.access(kickoff)).toBe("read")

    // Minutes are confidential: Bob reads the meeting, not them.
    expect(await bob.artifacts.access(minutes)).toBe("none")
    expect(await as("frank", [cleared.id]).artifacts.access(minutes)).toBe("read")
  })

  // Guard proof: return true from `holdsArtifact` in readableHoldings; the meeting's stale index
  // row then still shares the artifact once the code no longer declares `kickoffDoc`.
  test("trusts the objects as they read now, not the index", async () => {
    const { deps, as, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })

    const changed = new SixbHost({
      id: PROJECT,
      ontology: [MeetingWithoutKickoff, Task],
      ...security,
      ...deps,
    })
    expect(await as("bob", [readers.id], "session", changed).artifacts.access(kickoff)).toBe("none")

    // Cleared, the index follows the object.
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: null } })
    expect(await as("bob", [readers.id]).artifacts.access(kickoff)).toBe("none")
  })

  // Guard proof: answer `none` from ownAccess for a caller without `sharing`, as before; Bob's
  // access token then reads nothing an object holds.
  test("is reached with an access token too, unlike a conversation's", async () => {
    const { deps, as, doc, meetings } = await setup()
    const kickoff = await doc()
    const notes = await doc("Notes")
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    await shareInConversation(deps.storage, notes, ["bob"])

    const token = as("bob", [readers.id], "accessToken")
    expect(await token.artifacts.access(kickoff)).toBe("read")
    expect(await token.artifacts.access(notes)).toBe("none")
    expect(await as("bob", [readers.id]).artifacts.access(notes)).toBe("update")
  })

  // Guard proof: let `updatableArtifactIds` in artifacts/execution.ts keep `read`; Bob, who only
  // reads the meeting, then puts its document in a task, and every task editor updates it.
  test("is put in another object only by whoever may change it", async () => {
    const { deps, as, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    for (const id of ["bob", "carol"]) await seedSession(deps.storage, id)

    const bob = as("bob", [readers.id, taskEditors.id])
    const refused = await bob
      .objects(Task)
      .upsert({ properties: { id: "t1", doc: artifactRef(kickoff) } })
      .catch((error: unknown) => (error as Error).message)
    expect(refused).toBe(
      `[Sixb] Property 'Task.doc' references artifact '${kickoff}', which does not exist.`
    )
    expect(await bob.artifacts.access(kickoff)).toBe("read")

    // Carol edits the meeting, so she may change its document, and put it in a task.
    const carol = as("carol", [editors.id, taskEditors.id])
    await carol.objects(Task).upsert({ properties: { id: "t2", doc: artifactRef(kickoff) } })
    expect((await carol.objects(Task).get("t2"))?.properties.doc).toEqual(artifactRef(kickoff))
  })

  test("gives the most that any of its conversations and objects gives", async () => {
    const { deps, bob, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    expect(await bob.artifacts.access(kickoff)).toBe("read")

    await shareInConversation(deps.storage, kickoff, ["bob"])
    expect(await bob.artifacts.access(kickoff)).toBe("update")
  })

  // Guard proof: answer the `store` transaction's publishAccess with "update" in
  // createArtifactsRuntime; Carol's write then lands though the meeting let go of the artifact.
  test("checks a write again in the transaction that stores it", async () => {
    const { deps, carol, document, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    const files = await document("# Carol's plan\n")

    // The meeting lets go of the artifact while Carol's version is checked.
    const open = deps.blobStorage.open.bind(deps.blobStorage)
    spyOn(deps.blobStorage, "open").mockImplementationOnce(async (...args) => {
      await meetings.upsert({ properties: { id: "m1", kickoffDoc: null } })
      return open(...args)
    })

    const written = carol.artifacts.update(kickoff, { kind: "document", title: "Plan", files })
    expect(await refusal(written)).toBe("not_shared")
    expect(await deps.storage.artifacts.get({ projectId: PROJECT, id: kickoff })).toMatchObject({
      revision: 1,
    })
  })

  // Guard proof: give the transaction's readers the shared clearance in `readingFrom`
  // (authorized-object-reader.ts) instead of a pinned one; the projection applied as the
  // transaction opens then makes Carol's clearance read the project's storage inside it.
  test("decides inside a transaction under the clearance resolved before it", async () => {
    const { deps, host, carol, doc, meetings } = await setup({ datasets: [budgets] })
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })

    // A projection this process applies as the transaction opens refreshes what is marked.
    const transaction = deps.storage.transaction.bind(deps.storage)
    spyOn(deps.storage, "transaction").mockImplementationOnce((run, options) => {
      getAppliedMarkings(host).invalidate()
      return transaction(run, options)
    })

    expect((await carol.artifacts.freeze(kickoff)).version.frozenAt).toBeDefined()
  })

  test("announces its writes to whoever reads the object", async () => {
    const { host, bob, carol, dave, document, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    const cursor = await host.events.latestCursor()

    await carol.artifacts.update(kickoff, {
      kind: "document",
      title: "Plan",
      files: await document("# Carol's plan\n"),
    })

    const updates = async (reader: typeof bob) =>
      (
        await reader.events.read({
          ...(cursor === undefined ? {} : { afterCursor: cursor }),
          types: ["artifact.updated"],
        })
      ).map((event) => event.payload)
    expect(await updates(bob)).toEqual([
      { artifactId: kickoff, version: 1, revision: 2, frozen: false },
    ])
    expect(await updates(dave)).toEqual([])
  })
})

describe("the objects an artifact belongs to", () => {
  // Guard proof: read the holders' objects through `runtime.storage.objects` in
  // readableHoldings; Bob then sees the meeting whose minutes are confidential, and Erin the draft.
  test("are those the caller reads, with their titles", async () => {
    const { as, bob, dave, doc, meetings } = await setup()
    const kickoff = await doc()
    await meetings.upsert({
      properties: { id: "m1", title: "Kick-off", status: "open", kickoffDoc: artifactRef(kickoff) },
    })
    await meetings.upsert({
      properties: { id: "m2", status: "draft", kickoffDoc: artifactRef(kickoff) },
    })
    await meetings.upsert({ properties: { id: "m3", minutes: artifactRef(kickoff) } })

    expect(await bob.artifacts.holders(kickoff)).toEqual({
      holders: [
        { objectTypeId: "Meeting", primaryId: "m1", propertyId: "kickoffDoc", title: "Kick-off" },
        { objectTypeId: "Meeting", primaryId: "m2", propertyId: "kickoffDoc" },
      ],
      hasMore: false,
    })
    expect((await as("erin", [openOnly.id]).artifacts.holders(kickoff))?.holders).toEqual([
      { objectTypeId: "Meeting", primaryId: "m1", propertyId: "kickoffDoc", title: "Kick-off" },
    ])
    expect(await dave.artifacts.holders(kickoff)).toBeNull()
  })

  test("are the first twenty, saying when there are more", async () => {
    const { bob, doc, meetings } = await setup()
    const kickoff = await doc()
    for (let index = 10; index <= 30; index += 1) {
      await meetings.upsert({ properties: { id: `m${index}`, kickoffDoc: artifactRef(kickoff) } })
    }

    const holders = await bob.artifacts.holders(kickoff)
    expect(holders?.hasMore).toBe(true)
    expect(holders?.holders.map((holder) => holder.primaryId)).toEqual(
      Array.from({ length: 20 }, (_, index) => `m${index + 10}`)
    )
  })
})

/** Shares the artifact in Alice's conversation, which these people take part in. */
async function shareInConversation(
  storage: ReturnType<typeof createTestRuntimeDeps>["storage"],
  artifactId: string,
  participants: readonly string[]
) {
  const threadId = `thr_${artifactId}`
  const alice = { type: "user", id: "alice" } as const
  await storage.agents.threads.create({ projectId: PROJECT, id: threadId, ownerPrincipal: alice })
  await storage.agents.threads.addParticipants({
    projectId: PROJECT,
    threadId,
    principals: participants.map((id) => ({ type: "user", id })),
    addedBy: alice,
    maxParticipants: 50,
  })

  const artifact = await storage.artifacts.get({ projectId: PROJECT, id: artifactId })
  const version = await storage.artifacts.getVersion({
    projectId: PROJECT,
    artifactId,
    version: artifact?.latestVersion ?? 1,
  })
  if (!artifact || !version) throw new Error("Expected the artifact and its version.")

  await storage.artifacts.publish({
    projectId: PROJECT,
    artifactId,
    kind: artifact.kind,
    version: { ...version, origin: { threadId, runId: `run_${artifactId}` } },
  })
}

/** A signed-in member, as the writes of `as` need one to exist. */
async function seedSession(
  storage: ReturnType<typeof createTestRuntimeDeps>["storage"],
  id: string
) {
  await storage.auth.users.create({ projectId: PROJECT, id, email: `${id}@example.com` })
  await storage.auth.sessions.create({
    id: `session-${id}`,
    projectId: PROJECT,
    userId: id,
    strategyId: "test",
    tokenHash: `hash-${id}`,
    createdAt: new Date("2026-11-09T09:00:00.000Z"),
    expiresAt: new Date("2099-11-09T09:00:00.000Z"),
  })
}
