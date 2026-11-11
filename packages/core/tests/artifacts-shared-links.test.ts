import { describe, expect, test } from "bun:test"
import {
  ArtifactRequestError,
  artifactRef,
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  objectRef,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { createArtifactAccessRule } from "../src/artifacts/access"
import { bindRequestExecution } from "../src/execution/request"
import { SharedSessionProtocol } from "../src/shares/session-protocol"
import { createTestSixb } from "../src/testing"
import { createSharedTestScope } from "./shared-test-scope"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A shared link's visitor is a guest: they read the artifacts the link's objects hold, follow
// them, and comment under a name they give, and nothing else. The access rule decides it, as for
// every other caller; the server's tests prove the routes and sockets that ask it.

const PROJECT = "artifacts-shared-links"

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("title", "string"),
    prop("kickoffDoc", ref.artifact(), { nullable: true }),
  ],
})

const meetingShare = defineShare("meeting", {
  target: Meeting,
  grants: ({ target }) => [can.view(target)],
})

const readers = defineGroup("meeting-readers")
const editors = defineGroup("meeting-editors")

const security = {
  groups: [readers, editors],
  roles: [
    defineRole("meeting-reader", { grantedTo: [readers], grants: [can.view(Meeting)] }),
    defineRole("meeting-editor", {
      grantedTo: [editors],
      grants: [can.view(Meeting), can.edit(Meeting), can.share(meetingShare)],
    }),
  ],
}

async function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: PROJECT,
    ontology: [Meeting],
    shares: [meetingShare],
    ...security,
    ...deps,
  })
  const protocol = new SharedSessionProtocol({ host })

  const as = (id: string, groupIds: readonly string[] = []) =>
    bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "session", id: `session-${id}` },
        context: resolveAuthorizationContext({
          principal: { type: "user", id },
          sessionId: `session-${id}`,
          groupIds,
          roles: host.definitions.security.listResolvedRoles(),
        }),
      },
    })

  const alice = as("alice", [editors.id])
  const bob = as("bob", [readers.id])

  /** A visitor of a link to the meeting, in the session its secret opens. */
  const guestOf = async (primaryId: string) => {
    const invitation = await alice.shares.issue(meetingShare, {
      target: objectRef(Meeting, primaryId),
      destinationPath: `/meetings/${primaryId}`,
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })
    const credential = await protocol.exchange(invitation.grant.id, invitation.secret)
    if (!credential) throw new Error("The link's secret opened no session.")

    const { grantId, sessionId, access } = credential.context
    const sixb = host.withScope(
      createSharedTestScope({
        projectId: PROJECT,
        requestId: `shared-${sessionId}`,
        correlationId: `shared-${sessionId}`,
        access,
        delegation: { kind: "share", grantId, sessionId },
      })
    ) as ReturnType<typeof as>
    return { sixb, session: credential.context }
  }

  const document = async (title: string) => {
    const file = await deps.blobStorage.put({
      body: new TextEncoder().encode(`# ${title}\n`),
      fileName: "document.md",
      mediaType: "text/markdown",
    })
    const created = await alice.artifacts.create({
      kind: "document",
      title,
      files: [{ path: "document.md", file }],
    })
    return created.artifact.id
  }

  const meetings = createTestSixb(host).objects(Meeting)
  return { deps, host, protocol, alice, bob, guestOf, document, meetings }
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  return error instanceof ArtifactRequestError ? error.code : undefined
}

describe("a shared link's guest", () => {
  // Guard proof: map delegated authority to `null` again in accessRuleIn
  // (artifacts/execution.ts); the guest then reads nothing its meeting holds.
  test("reads what its link's objects hold, and nothing else", async () => {
    const { alice, guestOf, document, meetings } = await setup()
    const kickoff = await document("Kick-off")
    const other = await document("Other")
    const owned = await document("Alice's notes")
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    await meetings.upsert({ properties: { id: "m2", kickoffDoc: artifactRef(other) } })

    const { sixb: guest } = await guestOf("m1")
    expect(await guest.artifacts.access(kickoff)).toBe("read")
    expect(await guest.artifacts.access(other)).toBe("none")
    expect(await guest.artifacts.access(owned)).toBe("none")

    expect(await guest.artifacts.get(kickoff)).toMatchObject({ id: kickoff })
    expect(await guest.artifacts.getVersion(kickoff, "latest")).toMatchObject({ version: 1 })
    expect(await guest.artifacts.holders(kickoff)).toEqual({
      holders: [{ objectTypeId: Meeting.id, primaryId: "m1", propertyId: "kickoffDoc" }],
      hasMore: false,
    })
    expect(await guest.artifacts.get(other)).toBeNull()

    // The gallery is a member's: a guest lists nothing.
    expect((await guest.artifacts.list()).total).toBe(0)

    // Once the meeting lets go of it, the link reaches it no more.
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: null } })
    expect(await guest.artifacts.access(kickoff)).toBe("none")
    expect(await alice.artifacts.access(kickoff)).toBe("owner")
  })

  // A guest has no principal, which every write but a comment needs.
  test("changes nothing it reads", async () => {
    const { deps, guestOf, document, meetings } = await setup()
    const kickoff = await document("Kick-off")
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    const { sixb: guest } = await guestOf("m1")

    const files = (await deps.storage.artifacts.getVersion({
      projectId: PROJECT,
      artifactId: kickoff,
      version: 1,
    }))!.files
    const content = { kind: "document" as const, title: "Changed", files }

    expect(await refusal(guest.artifacts.update(kickoff, content))).toBe("read_only")
    expect(await refusal(guest.artifacts.freeze(kickoff))).toBe("not_allowed")
    expect(await refusal(guest.artifacts.restore(kickoff, 1))).toBe("not_allowed")
    expect(await refusal(guest.artifacts.state(kickoff).set("seen", true))).toBe("not_allowed")
    expect(await refusal(guest.artifacts.create(content))).toBe("not_allowed")
    expect(await guest.artifacts.delete(kickoff)).toBe(false)

    expect(await deps.storage.artifacts.get({ projectId: PROJECT, id: kickoff })).toMatchObject({
      title: "Kick-off",
      revision: 1,
    })
  })

  // Guard proof: count a guest's comment as its reader's own in `managed` (artifacts/comments.ts);
  // Bob, who only reads the meeting, then resolves it.
  test("comments under the name it gave, and resolves or deletes nothing", async () => {
    const { protocol, alice, bob, guestOf, document, meetings } = await setup()
    const kickoff = await document("Kick-off")
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    const { sixb: guest, session } = await guestOf("m1")

    expect(await refusal(guest.artifacts.addComment(kickoff, { body: "Hello" }))).toBe(
      "name_required"
    )

    await protocol.setGuestName(session, "Ava Martin")
    const comment = await guest.artifacts.addComment(kickoff, { body: "Can we start at 9?" })
    expect(comment.author).toEqual({
      type: "guest",
      id: session.sessionId,
      name: "Ava Martin",
      grantId: session.grantId,
    })
    expect(await guest.artifacts.listComments(kickoff)).toHaveLength(1)

    // Not even their own: resolving and deleting are for members who may change the artifact.
    const members = await alice.artifacts.addComment(kickoff, { body: "Noted" })
    for (const id of [comment.id, members.id]) {
      expect(await refusal(guest.artifacts.resolveComment(kickoff, id))).toBe("not_allowed")
      expect(await refusal(guest.artifacts.deleteComment(kickoff, id))).toBe("not_allowed")
    }

    // Bob only reads the meeting: a guest's comment is not his to resolve either.
    expect(await refusal(bob.artifacts.resolveComment(kickoff, comment.id))).toBe("not_allowed")
    expect((await alice.artifacts.resolveComment(kickoff, comment.id)).resolvedBy).toEqual({
      type: "user",
      id: "alice",
    })

    // The link revoked, the comment stays with the name it was written under.
    await protocol.revoke(session)
    expect((await alice.artifacts.listComments(kickoff))?.[0]?.author).toEqual(comment.author)
  })

  // Guard proof: answer `[]` for delegated authority in `visible` (events/execution.ts), as
  // before; the guest then follows no artifact.
  test("follows the events of the artifacts it reads, and no others", async () => {
    const { host, alice, guestOf, document, meetings } = await setup()
    const kickoff = await document("Kick-off")
    const other = await document("Other")
    await meetings.upsert({ properties: { id: "m1", kickoffDoc: artifactRef(kickoff) } })
    const { sixb: guest } = await guestOf("m1")
    const cursor = await host.events.latestCursor()

    await alice.artifacts.addComment(kickoff, { body: "On the plan" })
    await alice.artifacts.addComment(other, { body: "Elsewhere" })
    await meetings.upsert({
      properties: { id: "m1", title: "Kick-off", kickoffDoc: artifactRef(kickoff) },
    })

    const written = await host.events.read({
      ...(cursor === undefined ? {} : { afterCursor: cursor }),
    })
    const shown = await guest.events.visible(written)
    expect(
      shown.map((event) => [
        event.type,
        "artifactId" in event.payload ? event.payload.artifactId : null,
      ])
    ).toEqual([["artifact.commented", kickoff]])
  })
})

describe("the access rule, for a guest", () => {
  // Guard proof: drop the guest's cap in `throughObjects` (artifacts/access.ts), or its check in
  // `conversation`; a guest then updates what an object holds, or reads a conversation's artifact.
  test("only reads, and never through a conversation", async () => {
    const { deps, document } = await setup()
    const plan = await document("Plan")

    // Shared in a conversation, as the Agent's version would share it.
    const at = { projectId: PROJECT, id: plan }
    const artifact = (await deps.storage.artifacts.get(at))!
    const version = (await deps.storage.artifacts.getVersion({
      projectId: PROJECT,
      artifactId: plan,
      version: 1,
    }))!
    await deps.storage.artifacts.publish({
      projectId: PROJECT,
      artifactId: plan,
      kind: artifact.kind,
      version: { ...version, origin: { threadId: "thr_plan", runId: "run_plan" } },
    })

    const rule = (holders: "update" | "read" | null) =>
      createArtifactAccessRule({
        storage: deps.storage.artifacts,
        projectId: PROJECT,
        caller: "guest",
        sharing: true,
        conversation: async () => "update",
        holders: async () => holders,
      })

    expect(await rule("update").accessTo(artifact)).toBe("read")
    expect(await rule("update").publishAccess(artifact)).toBe("read")
    expect(await rule("update").publishAccess(artifact, "thr_plan")).toBe("none")
    expect(await rule(null).accessTo(artifact)).toBe("none")
    expect(await rule(null).conversation("thr_plan")).toBeNull()
  })
})
