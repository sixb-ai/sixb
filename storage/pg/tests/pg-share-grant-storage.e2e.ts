import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

const createdAt = new Date("2026-08-19T12:00:00.000Z")
const expiresAt = new Date("2026-08-20T12:00:00.000Z")

describe("PgShareGrantStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("persists the digest and keeps the first revocation evidence", async () => {
    await storage.shareGrants.create({
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

    await storage.shareGrants.revoke({
      projectId: "project-1",
      grantId: "shr_1",
      revokedAt: new Date("2026-08-19T13:00:00.000Z"),
      revokedBy: { type: "serviceAccount", id: "svc_1" },
      evidenceId: "she_revoked",
    })
    await storage.shareGrants.revoke({
      projectId: "project-1",
      grantId: "shr_1",
      revokedAt: new Date("2026-08-19T14:00:00.000Z"),
      revokedBy: { type: "user", id: "usr_2" },
      evidenceId: "she_duplicate",
    })

    await expect(
      storage.shareGrants.get({ projectId: "project-1", grantId: "shr_1" })
    ).resolves.toMatchObject({
      tokenDigest: "digest-only",
      revokedBy: { type: "serviceAccount", id: "svc_1" },
      revokedEvidenceId: "she_revoked",
    })
    await expect(
      storage.shareGrants.listEvidence({ projectId: "project-1", grantId: "shr_1" })
    ).resolves.toHaveLength(2)
  })
})
