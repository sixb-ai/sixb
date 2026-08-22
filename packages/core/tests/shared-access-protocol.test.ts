import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { can, defineAction, defineObjectType, defineShareType, prop } from "../src"
import { createDefinitionCatalog } from "../src/runtime/definitions"
import { DEFAULT_SHARED_ACCESS_SESSION_TTL_MS, SharedAccessProtocol } from "../src/shares/protocol"
import { InMemoryShareGrantStorage } from "../src/storage/share-grants"
import type { SharedAccessGrantRef } from "../src/storage/share-grants/types"
import { InMemoryShareSessionStorage } from "../src/storage/share-sessions"

const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { primary: true, required: true })],
})
const acknowledge = defineAction("acknowledge-report")
  .on(Report)
  .params({})
  .edits(() => {})
const PublishedReport = defineShareType({
  id: "published-report",
  target: Report,
  grants: [can.view(Report), can.apply(acknowledge)],
})
const PublishedReportWithoutAction = defineShareType({
  id: PublishedReport.id,
  target: Report,
  grants: [can.view(Report)],
})
const now = new Date("2026-08-20T12:00:00.000Z")
const linkSecret = "link-secret"

describe("SharedAccessProtocol", () => {
  test("exchanges a valid link for an independently secured short-lived session", async () => {
    const fixture = await createFixture({
      grantExpiresAt: new Date(now.getTime() + DEFAULT_SHARED_ACCESS_SESSION_TTL_MS * 2),
    })

    const exchanged = await fixture.protocol.exchange("shr_1", linkSecret, now)
    expect(exchanged).not.toBeNull()
    if (!exchanged) throw new Error("Expected exchange to succeed")
    expect(exchanged.context).toMatchObject({
      principal: { type: "sharedAccess", grantId: "shr_1" },
      grant: { id: "shr_1", shareTypeId: PublishedReport.id },
    })
    expect(exchanged.context.session.expiresAt).toEqual(
      new Date(now.getTime() + DEFAULT_SHARED_ACCESS_SESSION_TTL_MS)
    )

    const [sessionId, sessionSecret] = exchanged.cookieValue.split(".")
    if (!sessionId || !sessionSecret) throw new Error("Expected a complete session credential")
    expect(sessionId).toBe(exchanged.context.session.id)
    expect(sessionSecret).not.toBe(linkSecret)
    const stored = await fixture.sessions.get({ projectId: "project", sessionId })
    expect(stored?.tokenDigest).toBe(digest(sessionSecret))
    expect(stored?.tokenDigest).not.toContain(sessionSecret)
  })

  test("caps the session at the grant expiry", async () => {
    const grantExpiresAt = new Date(now.getTime() + 60_000)
    const fixture = await createFixture({ grantExpiresAt })

    const exchanged = await fixture.protocol.exchange("shr_1", linkSecret, now)
    expect(exchanged?.context.session.expiresAt).toEqual(grantExpiresAt)
  })

  test("fails closed for invalid, expired, revoked, and unregistered grants", async () => {
    const invalid = await createFixture()
    await expect(invalid.protocol.exchange("shr_1", "wrong-secret", now)).resolves.toBeNull()
    await expect(invalid.protocol.exchange("missing", linkSecret, now)).resolves.toBeNull()

    const expired = await createFixture({ grantExpiresAt: new Date(now) })
    await expect(expired.protocol.exchange("shr_1", linkSecret, now)).resolves.toBeNull()

    const revoked = await createFixture()
    await revoked.grants.revoke({
      projectId: "project",
      grantId: "shr_1",
      revokedAt: new Date(now),
      revokedBy: { type: "system", id: "system" },
    })
    await expect(revoked.protocol.exchange("shr_1", linkSecret, now)).resolves.toBeNull()

    const unregistered = await createFixture({ registered: false })
    await expect(unregistered.protocol.exchange("shr_1", linkSecret, now)).resolves.toBeNull()
  })

  test("resolves only the exact active session and rechecks the grant", async () => {
    const fixture = await createFixture()
    const exchanged = await fixture.protocol.exchange("shr_1", linkSecret, now)
    if (!exchanged) throw new Error("Expected exchange to succeed")

    await expect(
      fixture.protocol.resolve("shr_1", exchanged.cookieValue, now)
    ).resolves.toMatchObject({ principal: exchanged.context.principal })
    await expect(fixture.protocol.resolve("other", exchanged.cookieValue, now)).resolves.toBeNull()
    await expect(fixture.protocol.resolve("shr_1", "invalid", now)).resolves.toBeNull()

    await fixture.grants.revoke({
      projectId: "project",
      grantId: "shr_1",
      revokedAt: new Date(now),
      revokedBy: { type: "system", id: "system" },
    })
    await expect(fixture.protocol.resolve("shr_1", exchanged.cookieValue, now)).resolves.toBeNull()
  })

  test("revokes a shared session idempotently", async () => {
    const fixture = await createFixture()
    const exchanged = await fixture.protocol.exchange("shr_1", linkSecret, now)
    if (!exchanged) throw new Error("Expected exchange to succeed")
    const revokedAt = new Date(now.getTime() + 1_000)

    const revoked = await fixture.protocol.revoke(exchanged.context, revokedAt)
    expect(revoked?.revokedAt).toEqual(revokedAt)
    await expect(
      fixture.protocol.resolve("shr_1", exchanged.cookieValue, revokedAt)
    ).resolves.toBeNull()
    await expect(
      fixture.protocol.revoke(exchanged.context, new Date(now.getTime() + 2_000))
    ).resolves.toEqual(revoked)
  })

  test("keeps the issued snapshot while exposing only currently effective grants", async () => {
    const removed = await createFixture({ registeredShareType: PublishedReportWithoutAction })
    const removedExchange = await removed.protocol.exchange("shr_1", linkSecret, now)
    expect(removedExchange?.context.grant.grants).toEqual([
      { capability: "view", objectTypeId: Report.id },
      { capability: "apply", actionId: acknowledge.id },
    ])
    expect(removedExchange?.context.effectiveGrants).toEqual([
      { capability: "view", objectTypeId: Report.id },
    ])

    const added = await createFixture({
      issuedGrants: [{ capability: "view", objectTypeId: Report.id }],
    })
    const addedExchange = await added.protocol.exchange("shr_1", linkSecret, now)
    expect(addedExchange?.context.effectiveGrants).toEqual([
      { capability: "view", objectTypeId: Report.id },
    ])
  })
})

async function createFixture(
  options: {
    readonly grantExpiresAt?: Date
    readonly issuedGrants?: readonly SharedAccessGrantRef[]
    readonly registered?: boolean
    readonly registeredShareType?: typeof PublishedReport
  } = {}
) {
  const grants = new InMemoryShareGrantStorage()
  const sessions = new InMemoryShareSessionStorage()
  await grants.create({
    id: "shr_1",
    projectId: "project",
    shareTypeId: PublishedReport.id,
    target: { objectTypeId: Report.id, primaryId: "report-1" },
    issuedBy: { type: "user", id: "usr_1" },
    grants: options.issuedGrants ?? [
      { capability: "view", objectTypeId: Report.id },
      { capability: "apply", actionId: acknowledge.id },
    ],
    tokenDigest: digest(linkSecret),
    createdAt: new Date(now.getTime() - 1_000),
    expiresAt: options.grantExpiresAt ?? new Date(now.getTime() + 60 * 60_000),
  })
  const protocol = new SharedAccessProtocol({
    projectId: "project",
    shareTypes: createDefinitionCatalog(
      new Map(
        options.registered === false
          ? []
          : [[PublishedReport.id, options.registeredShareType ?? PublishedReport]]
      )
    ),
    storage: { shareGrants: grants, shareSessions: sessions },
  })
  return { grants, sessions, protocol }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}
