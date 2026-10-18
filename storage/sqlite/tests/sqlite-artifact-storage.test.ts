import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { runArtifactStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runArtifactStorageContractSuite("SqliteArtifactStorage", {
  createStorage: () => new SqliteStorage(),
  teardown: (storage) => storage.close(),
})

describe("SqliteArtifactStorage frame grants", () => {
  // The column only has to hold a JSON array. To see this fail, read `targets` back with a bare
  // `JSON.parse` in `findFrameGrant`: the grant then comes back with a target that has no version.
  test("refuses a stored grant whose targets do not read back", async () => {
    const storage = new SqliteStorage()
    try {
      const createdAt = new Date("2026-10-17T10:00:00.000Z")
      await storage.artifacts.create({
        projectId: "project",
        id: "art_deck",
        kind: "slides",
        owner: { type: "user", id: "usr_owner" },
        version: {
          title: "Deck",
          entry: "index.html",
          files: [],
          outline: { kind: "slides", slides: [] },
          references: [],
          author: { type: "user", id: "usr_owner" },
          createdAt,
        },
      })
      const db = (storage as unknown as { connection: { db: Database } }).connection.db
      db.query(
        `INSERT INTO artifact_frame_grants
           (project_id, token_hash, artifact_id, version, targets, created_at, expires_at)
         VALUES ('project', ?, 'art_deck', 1, ?, ?, ?)`
      ).run(
        "a".repeat(64),
        JSON.stringify([{ address: "artifact:art_chart", artifactId: "art_chart" }]),
        createdAt.toISOString(),
        new Date(createdAt.getTime() + 60 * 60 * 1000).toISOString()
      )

      await expect(
        storage.artifacts.findFrameGrant({ projectId: "project", tokenHash: "a".repeat(64) })
      ).rejects.toThrow(
        "[Sixb] Stored frame grant for artifact 'art_deck' is invalid: a target is not an address, an artifact, and a version."
      )
    } finally {
      storage.close()
    }
  })
})
