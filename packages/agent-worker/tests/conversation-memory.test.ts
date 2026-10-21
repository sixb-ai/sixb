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
  const sixbAs = (principal: AuthorizablePrincipal) =>
    createTestSixb(host, {
      authorization: {
        principal,
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), "run:agent": true },
      },
    })
  // Saved straight to storage, so each revision has a fixed time.
  const save = (input: {
    baseRevision: number
    at: Date
    changes: { path: string; contents: string | null }[]
  }) =>
    storage.agents.memory.save({
      projectId: PROJECT_ID,
      repoId: "user:usr_priya",
      baseRevision: input.baseRevision,
      message: "Remember",
      author: { type: "user", id: "usr_priya" },
      changes: input.changes,
      createdAt: input.at,
    })
  return { sixbAs, save }
}

const priya = { type: "user", id: "usr_priya" } as const

describe("a conversation's memory", () => {
  test("installs the latest files and shows MEMORY.md as it was at the given time", async () => {
    const { sixbAs, save } = setup()
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
      sixb: sixbAs(priya),
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
      ],
      prompt: {
        repos: [{ repo: "user", entry: "# Before\n" }],
      },
    })
  })

  test("shows the starter MEMORY.md for a repo with no save by then", async () => {
    const { sixbAs, save } = setup()
    await save({
      baseRevision: 0,
      at: minutes(5),
      changes: [{ path: "MEMORY.md", contents: "# After\n" }],
    })

    const memory = await loadConversationMemory({
      sixb: sixbAs(priya),
      asOf: threadStart,
    })

    expect(memory?.prompt.repos).toEqual([{ repo: "user", entry: "# Memory\n\n" }])
  })

  test("is absent for a requester with no memory of its own", async () => {
    const { sixbAs } = setup()

    expect(
      await loadConversationMemory({
        sixb: sixbAs({ type: "serviceAccount", id: "svc_reports" }),
        asOf: threadStart,
      })
    ).toBeUndefined()
  })
})
