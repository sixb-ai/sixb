import { describe, expect, test } from "bun:test"
import {
  type AuthorizablePrincipal,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { readAgentRunMemory } from "@sixb/core/internal/agents"
import { emptyGrantIndex } from "@sixb/core/internal/authorization"
import { createTestSixb } from "@sixb/core/testing"
import { loadConversationMemory } from "../src/conversation-memory"

const PROJECT_ID = "conversation-memory"
const threadStart = new Date("2026-10-13T10:00:00.000Z")
const minutes = (count: number) => new Date(threadStart.getTime() + count * 60_000)

function setup() {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: PROJECT_ID,
    ontology: [],
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const sixbAs = (principal: AuthorizablePrincipal, options: { agent?: boolean } = {}) =>
    createTestSixb(host, {
      authorization: {
        principal,
        groupIds: [],
        roleIds: [],
        grants: {
          ...emptyGrantIndex(),
          "run:agent": options.agent ?? true,
        },
      },
    })
  // Saved straight to storage, so each revision has a fixed time.
  const save = (input: {
    repoId?: string
    baseRevision: number
    at: Date
    changes: { path: string; contents: string | null }[]
  }) =>
    storage.agents.memory.save({
      projectId: PROJECT_ID,
      repoId: input.repoId ?? "user:usr_priya",
      baseRevision: input.baseRevision,
      message: "Remember",
      author: { type: "user", id: "usr_priya" },
      changes: input.changes,
      createdAt: input.at,
    })
  const sessionAs = (principal: AuthorizablePrincipal, options: { agent?: boolean } = {}) =>
    sessionOf(sixbAs(principal, options))
  return { sessionAs, save }
}

const priya = { type: "user", id: "usr_priya" } as const

/** A run's session as it reads memory: through the run's SDK, bound as its requester. */
function sessionOf(sixb: Parameters<typeof readAgentRunMemory>[0]) {
  return {
    memory: ({ asOf }: { readonly asOf: Date }) =>
      readAgentRunMemory(sixb, { shared: false, asOf }),
  }
}

describe("a conversation's memory", () => {
  test("installs the latest files and shows MEMORY.md as it was at the given time", async () => {
    const { sessionAs, save } = setup()
    await save({
      baseRevision: 0,
      at: minutes(-5),
      changes: [{ path: "MEMORY.md", contents: "# Before\n" }],
    })
    await save({
      baseRevision: 1,
      at: minutes(5),
      changes: [
        { path: "MEMORY.md", contents: "# After\n" },
        { path: "topics/payments.md", contents: "- Excluding VAT\n" },
      ],
    })

    const memory = await loadConversationMemory({
      session: sessionAs(priya),
      asOf: threadStart,
    })

    expect(memory).toEqual({
      repos: [
        {
          repo: "user",
          revision: 2,
          files: [
            { path: "MEMORY.md", contents: "# After\n" },
            { path: "topics/payments.md", contents: "- Excluding VAT\n" },
          ],
        },
        { repo: "project", revision: 0, files: [] },
      ],
      prompt: {
        repos: [
          { repo: "user", entry: "# Before\n" },
          { repo: "project", entry: "# Memory\n\n" },
        ],
      },
    })
  })

  test("shows the starter MEMORY.md for a repo with no save by then", async () => {
    const { sessionAs, save } = setup()
    await save({
      baseRevision: 0,
      at: minutes(5),
      changes: [{ path: "MEMORY.md", contents: "# After\n" }],
    })

    const memory = await loadConversationMemory({
      session: sessionAs(priya),
      asOf: threadStart,
    })

    expect(memory?.prompt.repos[0]).toEqual({ repo: "user", entry: "# Memory\n\n" })
  })

  test("shows the project's memory after the user's, to everyone who can run the agent", async () => {
    const { sessionAs, save } = setup()
    await save({
      repoId: "project",
      baseRevision: 0,
      at: minutes(-5),
      changes: [{ path: "MEMORY.md", contents: "# Project\n" }],
    })

    const memory = await loadConversationMemory({ session: sessionAs(priya), asOf: threadStart })
    expect(memory?.prompt.repos).toEqual([
      { repo: "user", entry: "# Memory\n\n" },
      { repo: "project", entry: "# Project\n" },
    ])
    expect(memory?.repos.map((repo) => repo.repo)).toEqual(["user", "project"])
  })

  test("shows an empty project memory as a starter, so every conversation can add to it", async () => {
    const { sessionAs } = setup()

    const memory = await loadConversationMemory({ session: sessionAs(priya), asOf: threadStart })
    expect(memory?.prompt.repos).toEqual([
      { repo: "user", entry: "# Memory\n\n" },
      { repo: "project", entry: "# Memory\n\n" },
    ])
  })

  test("gives a requester with no memory of its own the project's alone", async () => {
    const { sessionAs, save } = setup()
    await save({
      repoId: "project",
      baseRevision: 0,
      at: minutes(-5),
      changes: [{ path: "MEMORY.md", contents: "# Project\n" }],
    })

    expect(
      (
        await loadConversationMemory({
          session: sessionAs({ type: "serviceAccount", id: "svc_reports" }),
          asOf: threadStart,
        })
      )?.prompt.repos
    ).toEqual([{ repo: "project", entry: "# Project\n" }])
  })

  test("is absent for a requester who cannot run the agent", async () => {
    const { sessionAs } = setup()

    expect(
      await loadConversationMemory({
        session: sessionAs({ type: "serviceAccount", id: "svc_reports" }, { agent: false }),
        asOf: threadStart,
      })
    ).toBeUndefined()
  })
})
