import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { SqliteShareGrantStorage } from "../src/share-grant-storage"

const createdAt = new Date("2026-08-19T12:00:00.000Z")
const expiresAt = new Date("2026-08-20T12:00:00.000Z")

describe("SqliteShareGrantStorage", () => {
  let storage: SqliteShareGrantStorage

  beforeEach(() => {
    storage = new SqliteShareGrantStorage()
  })

  afterEach(() => storage.close())

  test("persists hashed credentials and idempotent revocation evidence", async () => {
    const created = await storage.create({
      id: "shr_1",
      projectId: "project-1",
      shareTypeId: "published-report",
      target: { objectTypeId: "report", primaryId: "report-1" },
      issuedBy: { type: "user", id: "usr_1" },
      grants: [{ capability: "view", objectTypeId: "report" }],
      tokenDigest: "digest-only",
      createdAt,
      expiresAt,
      issuedEvidenceId: "she_issued",
    })

    expect(created).toMatchObject({
      id: "shr_1",
      tokenDigest: "digest-only",
      issuedBy: { type: "user", id: "usr_1" },
    })
    await expect(
      storage.list({
        projectId: "project-1",
        shareTypeId: "published-report",
        target: { objectTypeId: "report", primaryId: "report-1" },
        now: createdAt,
      })
    ).resolves.toHaveLength(1)

    await storage.revoke({
      projectId: "project-1",
      grantId: "shr_1",
      revokedAt: new Date("2026-08-19T13:00:00.000Z"),
      revokedBy: { type: "serviceAccount", id: "svc_1" },
      evidenceId: "she_revoked",
    })
    await storage.revoke({
      projectId: "project-1",
      grantId: "shr_1",
      revokedAt: new Date("2026-08-19T14:00:00.000Z"),
      revokedBy: { type: "user", id: "usr_2" },
      evidenceId: "she_duplicate",
    })

    await expect(
      storage.listEvidence({ projectId: "project-1", grantId: "shr_1" })
    ).resolves.toEqual([
      {
        id: "she_issued",
        projectId: "project-1",
        grantId: "shr_1",
        type: "share.grant.issued",
        actor: { type: "user", id: "usr_1" },
        occurredAt: createdAt,
      },
      {
        id: "she_revoked",
        projectId: "project-1",
        grantId: "shr_1",
        type: "share.grant.revoked",
        actor: { type: "serviceAccount", id: "svc_1" },
        occurredAt: new Date("2026-08-19T13:00:00.000Z"),
      },
    ])
  })

  test("filters expired grants by default", async () => {
    await storage.create({
      id: "shr_expired",
      projectId: "project-1",
      shareTypeId: "published-report",
      target: { objectTypeId: "report", primaryId: "report-1" },
      issuedBy: { type: "user", id: "usr_1" },
      grants: [{ capability: "view", objectTypeId: "report" }],
      tokenDigest: "expired-digest",
      createdAt,
      expiresAt,
      issuedEvidenceId: "she_expired",
    })

    await expect(
      storage.list({ projectId: "project-1", now: new Date("2026-08-21T00:00:00.000Z") })
    ).resolves.toEqual([])
    await expect(
      storage.list({
        projectId: "project-1",
        now: new Date("2026-08-21T00:00:00.000Z"),
        includeExpired: true,
      })
    ).resolves.toHaveLength(1)
  })
})
