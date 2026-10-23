import { describe, expect, test } from "bun:test"
import type { SaveAgentMemoryInput } from "@sixb/core/storage"
import { runAgentMemoryStorageContractSuite } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage, waitForLockWait } from "./helpers"

runAgentMemoryStorageContractSuite("PgAgentMemoryStore", {
  createStorage: async () => (await createTestStorage()).storage,
  teardown: disposeTestStorage,
})

const projectId = "pg-memory"
const save = (baseRevision: number, path: string): SaveAgentMemoryInput => ({
  projectId,
  repoId: "project",
  baseRevision,
  message: `Save ${path}`,
  author: { type: "user", id: "usr_priya" },
  changes: [{ path, contents: `${path}\n` }],
  createdAt: new Date("2026-10-13T10:00:00.000Z"),
})

describe("PgAgentMemoryStore under concurrent saves", () => {
  test("a save that waited for another takes the next revision", async () => {
    // Reproduce by dropping the advisory lock at the start of `save`: the waiting save reads the
    // head before the first commits, inserts the same revision, and fails on the primary key.
    const { storage, schemaName, connectionString } = await createTestStorage()
    // Another process on the same database, as a second run would be.
    const other = new PostgresStorage({
      connectionString,
      schemaName,
      max: 2,
    })
    try {
      await storage.agents.memory.save(save(0, "MEMORY.md"))
      let waiting: ReturnType<typeof other.agents.memory.save> | undefined
      await storage.transaction(async (tx) => {
        // The first save holds the repo's lock until this transaction commits.
        await tx.agents?.memory.save(save(1, "a.md"))
        waiting = other.agents.memory.save(save(1, "b.md"))
        await waitForLockWait(connectionString, waiting)
      })

      expect(await waiting).toEqual({ saved: true, revision: 3 })
      expect((await storage.agents.memory.get({ projectId, repoId: "project" })).files).toEqual([
        { path: "MEMORY.md", contents: "MEMORY.md\n" },
        { path: "a.md", contents: "a.md\n" },
        { path: "b.md", contents: "b.md\n" },
      ])
    } finally {
      await other.close()
      await disposeTestStorage(storage)
    }
  })
})
