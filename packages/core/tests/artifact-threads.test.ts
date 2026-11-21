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

  /** A conversation of Alice's the artifact is written from, last updated at `updatedAt`. */
  const conversation = async (id: string, updatedAt: string, participants: string[] = []) => {
    const alice = { type: "user", id: "usr_alice" } as const
    await deps.storage.agents.threads.create({
      projectId: PROJECT,
      id,
      ownerPrincipal: alice,
      createdAt: new Date("2026-11-21T08:00:00.000Z"),
      updatedAt: new Date(updatedAt),
    })
    if (participants.length > 0) {
      await deps.storage.agents.threads.addParticipants({
        projectId: PROJECT,
        threadId: id,
        principals: participants.map((each) => ({ type: "user", id: each })),
        addedBy: alice,
        maxParticipants: 50,
      })
    }
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

  return { as, artifactId: artifact.id, conversation }
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
})
