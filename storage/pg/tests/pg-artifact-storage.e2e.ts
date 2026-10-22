import { describe, expect, test } from "bun:test"
import type { ArtifactVersionInput } from "@sixb/core/storage"
import { runArtifactStorageContractSuite } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { createTestStorage, disposeTestStorage, waitForLockWait } from "./helpers"

runArtifactStorageContractSuite("PgArtifactStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  teardown: disposeTestStorage,
})

const projectId = "pg-artifacts"
const owner = { type: "user" as const, id: "usr_owner" }
const version = (runId: string, minute: number): ArtifactVersionInput => ({
  title: "Report",
  entry: "document.md",
  files: [],
  outline: { kind: "document", headings: [] },
  references: [],
  author: owner,
  origin: { threadId: "thr_1", runId },
  createdAt: new Date(Date.UTC(2026, 9, 17, 12, minute)),
})

describe("PgArtifactStorage under concurrent writes", () => {
  test("a failed run's cleanup keeps a version published while it waited", async () => {
    // Reproduce by dropping the `FOR UPDATE` lock at the start of `deleteVersionsByOrigin`: the
    // cleanup reads the artifact as the failed run left it, deletes it, and the cascade takes the
    // version published meanwhile.
    const { storage, schemaName, connectionString } = await createTestStorage()
    // Another process on the same database, as a retry's cleanup would be.
    const other = new PostgresStorage({
      connectionString,
      schemaName,
      max: 2,
    })
    try {
      const artifacts = storage.artifacts
      await artifacts.create({
        projectId,
        id: "art_raced",
        kind: "document",
        owner,
        version: version("run_failed", 0),
      })
      let cleanup: Promise<number> | undefined
      await storage.transaction(async (tx) => {
        // The publish holds the artifact's lock until this transaction commits.
        await tx.artifacts?.publish({
          projectId,
          artifactId: "art_raced",
          kind: "document",
          version: version("run_retried", 1),
        })
        cleanup = other.artifacts.deleteVersionsByOrigin({ projectId, runId: "run_failed" })
        await waitForLockWait(connectionString, cleanup)
      })
      expect(await cleanup).toBe(1)
      expect(await artifacts.get({ projectId, id: "art_raced" })).toMatchObject({
        latestVersion: 2,
      })
      expect(
        await artifacts.getVersion({ projectId, artifactId: "art_raced", version: 2 })
      ).not.toBeNull()
    } finally {
      await other.close()
      await disposeTestStorage(storage)
    }
  })

  test("of two publishes from one base, the one that waited finds the artifact moved", async () => {
    // Reproduce by checking the base against a `latest_version` read with `this.sql` before
    // `runPgTransaction` in `publish`: the second publish reads version 1 while the first is
    // uncommitted and is stored as version 3. Dropping the `FOR UPDATE` instead fails it with a
    // duplicate `artifact_versions` key rather than `artifact_moved`.
    const { storage, schemaName, connectionString } = await createTestStorage()
    // Another process on the same database, as a save from a second tab can reach.
    const other = new PostgresStorage({ connectionString, schemaName, max: 2 })
    try {
      const artifacts = storage.artifacts
      await artifacts.create({
        projectId,
        id: "art_raced",
        kind: "document",
        owner,
        version: version("run_created", 0),
      })

      let second: Promise<unknown> | undefined
      await storage.transaction(async (tx) => {
        // The first publish holds the artifact's lock until this transaction commits.
        await tx.artifacts?.publish({
          projectId,
          artifactId: "art_raced",
          kind: "document",
          baseVersion: 1,
          version: version("run_first", 1),
        })

        second = other.artifacts
          .publish({
            projectId,
            artifactId: "art_raced",
            kind: "document",
            baseVersion: 1,
            version: version("run_second", 2),
          })
          .catch((error: unknown) => error)
        await waitForLockWait(connectionString, second)
      })

      expect(await second).toMatchObject({
        code: "artifact_moved",
        latest: { version: 2, author: owner },
      })
      expect(await artifacts.get({ projectId, id: "art_raced" })).toMatchObject({
        latestVersion: 2,
      })
    } finally {
      await other.close()
      await disposeTestStorage(storage)
    }
  })
})
