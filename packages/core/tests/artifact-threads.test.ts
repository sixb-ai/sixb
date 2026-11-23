import { describe, expect, test } from "bun:test"
import { SixbHost } from "../src"
import type { AuthorizationContext } from "../src/authorization"
import { emptyGrantIndex } from "../src/authorization/types"
import { bindRequestExecution } from "../src/execution/request"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// The conversations about an artifact, as a page built around it reopens them on any device: those
// it is shared in, among those the reader owns or takes part in.

const PROJECT = "artifact-threads"

function member(id: string): AuthorizationContext {
  return {
    principal: { type: "user", id },
    groupIds: [],
    roleIds: [],
    grants: { ...emptyGrantIndex(), "run:agent": true },
  }
}

async function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: PROJECT, ontology: [], ...deps })
  for (const id of ["usr_alice", "usr_bob", "usr_dave"]) {
    await deps.storage.auth.users.create({ projectId: PROJECT, id, email: `${id}@example.com` })
    await deps.storage.auth.sessions.create({
      id: `session-${id}`,
      projectId: PROJECT,
      userId: id,
      strategyId: "test",
      tokenHash: `hash-${id}`,
      createdAt: new Date("2026-11-21T08:00:00.000Z"),
      expiresAt: new Date("2099-11-21T08:00:00.000Z"),
    })
  }

  /** A member signed in with a session, the credential conversations share artifacts with. */
  const as = (id: string) =>
    bindRequestExecution(host, {
      request: new Request("http://localhost/test"),
      authorization: {
        type: "principal",
        credential: { type: "session", id: `session-${id}` },
        context: { ...member(id), sessionId: `session-${id}` },
      },
    })

  const file = await deps.blobStorage.put({
    body: new TextEncoder().encode("# Teaser"),
    fileName: "document.md",
    mediaType: "text/markdown",
  })
  const { artifact, version } = await as("usr_alice").artifacts.create({
    kind: "document",
    title: "Teaser",
    files: [{ path: "document.md", file }],
  })

  /** A conversation of `owner`'s, last updated at `updatedAt`, that Bob or Dave may take part in. */
  const thread = async (
    id: string,
    updatedAt: string,
    participants: string[] = [],
    owner = "usr_alice"
  ) => {
    const ownerPrincipal = { type: "user", id: owner } as const
    await deps.storage.agents.threads.create({
      projectId: PROJECT,
      id,
      ownerPrincipal,
      createdAt: new Date("2026-11-21T08:00:00.000Z"),
      updatedAt: new Date(updatedAt),
    })
    if (participants.length > 0) {
      await deps.storage.agents.threads.addParticipants({
        projectId: PROJECT,
        threadId: id,
        principals: participants.map((each) => ({ type: "user", id: each })),
        addedBy: ownerPrincipal,
        maxParticipants: 50,
      })
    }
  }

  /** A conversation of Alice's the artifact is written from, last updated at `updatedAt`. */
  const conversation = async (id: string, updatedAt: string, participants: string[] = []) => {
    await thread(id, updatedAt, participants)
    const stored = await deps.storage.artifacts.getVersion({
      projectId: PROJECT,
      artifactId: artifact.id,
      version: version.version,
    })
    if (!stored) throw new Error("Expected the artifact's version.")
    await deps.storage.artifacts.publish({
      projectId: PROJECT,
      artifactId: artifact.id,
      kind: "document",
      version: { ...stored, origin: { threadId: id, runId: `run_${id}` } },
    })
  }

  /**
   * A message that brings the artifact to a conversation as context, sent at `sentAt`, as a page
   * beside it sends one with `agentContext.artifact()`: the Agent has not written it there.
   */
  const bringUp = (threadId: string, sentAt: string) =>
    deps.storage.agents.messages.append({
      projectId: PROJECT,
      id: `msg_${threadId}_${sentAt}`,
      threadId,
      runId: null,
      role: "user",
      parts: [
        { type: "context", context: { kind: "artifact", id: artifact.id }, origin: "ambient" },
        { type: "text", text: "Tighten the intro" },
      ],
      createdAt: new Date(sentAt),
    })

  return { as, artifactId: artifact.id, conversation, thread, bringUp }
}

describe("sixb.agent.threads.listForArtifact()", () => {
  // Reproduce by listing every thread `listThreadIds` names in listForArtifact
  // (agents/execution.ts), without reading each as the caller: Bob gets Alice's own conversation.
  test("lists the conversations the reader reads, most recently updated first", async () => {
    const { as, artifactId, conversation } = await setup()
    await conversation("thr_team", "2026-11-21T09:00:00.000Z", ["usr_bob"])
    await conversation("thr_alone", "2026-11-21T10:00:00.000Z")

    const ids = async (id: string) =>
      (await as(id).agent.threads.listForArtifact(artifactId))?.map((thread) => thread.id)

    expect(await ids("usr_alice")).toEqual(["thr_alone", "thr_team"])
    expect(await ids("usr_bob")).toEqual(["thr_team"])
    // Dave reads neither the artifact nor its conversations.
    expect(await as("usr_dave").agent.threads.listForArtifact(artifactId)).toBeNull()
  })

  // Reproduce by listing only `listThreadIds` in listForArtifact (agents/execution.ts): the
  // conversations started beside the artifact, which the Agent has not written it from, are gone.
  test("lists the conversations a message brought the artifact to, each once", async () => {
    const { as, artifactId, conversation, thread, bringUp } = await setup()
    // Bob reads the artifact through the conversation it was written from.
    await conversation("thr_written", "2026-11-21T09:00:00.000Z", ["usr_bob"])

    // Started beside the artifact, the Agent not having written it yet: Bob takes part in one.
    await thread("thr_beside", "2026-11-21T08:00:00.000Z")
    await bringUp("thr_beside", "2026-11-21T11:00:00.000Z")
    await thread("thr_team", "2026-11-21T08:00:00.000Z", ["usr_bob"])
    await bringUp("thr_team", "2026-11-21T10:00:00.000Z")

    // Written from, and brought up twice since: listed once, as last updated.
    await conversation("thr_both", "2026-11-21T08:00:00.000Z")
    await bringUp("thr_both", "2026-11-21T08:30:00.000Z")
    await bringUp("thr_both", "2026-11-21T12:00:00.000Z")

    // Dave's, which Alice does not read, though it brings up her artifact.
    await thread("thr_dave", "2026-11-21T08:00:00.000Z", [], "usr_dave")
    await bringUp("thr_dave", "2026-11-21T13:00:00.000Z")

    const ids = async (id: string) =>
      (await as(id).agent.threads.listForArtifact(artifactId))?.map((each) => each.id)

    expect(await ids("usr_alice")).toEqual(["thr_both", "thr_beside", "thr_team", "thr_written"])
    expect(await ids("usr_bob")).toEqual(["thr_team", "thr_written"])
    // Bringing it up shares nothing: Dave still does not read the artifact.
    expect(await as("usr_dave").agent.threads.listForArtifact(artifactId)).toBeNull()
  })
})
