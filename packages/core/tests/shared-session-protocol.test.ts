import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  can,
  defineAction,
  defineObjectType,
  defineShare,
  objectRef,
  prop,
  SixbHost,
  type SixbHostView,
} from "../src"
import { compileShareAccessPlan } from "../src/shares"
import { SharedSessionProtocol } from "../src/shares/session-protocol"
import type { ShareGrantRecord } from "../src/storage"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { required: true, primary: true }), prop("title", "string")],
})

const acknowledge = defineAction("acknowledge-report")
  .on(Report)
  .params({})
  .edits(() => {})

const BroadShare = defineShare("published-report", {
  target: Report,
  grants: ({ target }) => [can.view(target), can.apply(acknowledge).on(target)],
})

const NarrowShare = defineShare("published-report", {
  target: Report,
  grants: ({ target }) => [can.view(target)],
})

const target = objectRef(Report, "report-1")
const linkSecret = "s".repeat(43)
const start = new Date("2026-08-01T12:00:00.000Z")

function hostWith(shares: readonly (typeof BroadShare)[], deps = createTestRuntimeDeps()) {
  return new SixbHost({
    id: "shared-session-project",
    ontology: [Report],
    actions: [acknowledge],
    shares,
    ...deps,
  })
}

async function seedGrant(
  host: SixbHostView,
  input: { readonly id?: string; readonly expiresAt?: Date } = {}
): Promise<ShareGrantRecord> {
  const expiresAt = input.expiresAt ?? new Date(start.getTime() + 60 * 60_000)
  return host.storage.shareGrants!.create({
    id: input.id ?? "shr_one",
    projectId: host.id,
    definitionId: BroadShare.id,
    target,
    issuedBy: { type: "user", id: "issuer" },
    authoritySnapshot: {
      version: 1,
      access: compileShareAccessPlan({
        share: BroadShare,
        target,
        ontology: host.definitions.ontology,
        actions: host.definitions.actions,
      }),
    },
    tokenHash: sha256(linkSecret),
    destinationPath: "/reports/report-1",
    createdAt: start,
    expiresAt,
  })
}

describe("SharedSessionProtocol", () => {
  test("exchanges each valid link secret for a new hashed short-lived credential", async () => {
    const host = hostWith([BroadShare])
    await seedGrant(host)
    let now = new Date(start)
    const protocol = new SharedSessionProtocol({
      host,
      inactivityTtlMs: 10 * 60_000,
      now: () => now,
    })

    await expect(protocol.exchange("missing", linkSecret)).resolves.toBeNull()
    await expect(protocol.exchange("shr_one", "x".repeat(43))).resolves.toBeNull()

    const first = await protocol.exchange("shr_one", linkSecret)
    const second = await protocol.exchange("shr_one", linkSecret)
    expect(first?.cookieValue).not.toEqual(second?.cookieValue)
    expect(first?.context).toMatchObject({
      grantId: "shr_one",
      destinationPath: "/reports/report-1",
      expiresAt: new Date(start.getTime() + 10 * 60_000),
    })
    expect(first?.context.access.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "object.view" }),
        expect.objectContaining({ kind: "action.apply", actionId: acknowledge.id }),
      ])
    )

    const session = await host.storage.shareSessions!.getById({
      projectId: host.id,
      id: first!.context.sessionId,
    })
    expect(session?.tokenHash).toBe(
      sha256(first!.cookieValue.slice(first!.cookieValue.indexOf(".") + 1))
    )
    expect(JSON.stringify(session)).not.toContain(first!.cookieValue)
    now = new Date(now.getTime() + 1)
  })

  test("renews only foreground activity and never crosses the grant deadline", async () => {
    const host = hostWith([BroadShare])
    await seedGrant(host, { expiresAt: new Date(start.getTime() + 20 * 60_000) })
    let now = new Date(start)
    const protocol = new SharedSessionProtocol({
      host,
      inactivityTtlMs: 10 * 60_000,
      now: () => now,
    })
    const credential = (await protocol.exchange("shr_one", linkSecret))!

    now = new Date(start.getTime() + 4 * 60_000)
    const background = await protocol.resolve("shr_one", credential.cookieValue)
    expect(background?.expiresAt).toEqual(new Date(start.getTime() + 10 * 60_000))

    const foreground = await protocol.resolve("shr_one", credential.cookieValue, {
      activity: "foreground",
    })
    expect(foreground?.expiresAt).toEqual(new Date(start.getTime() + 14 * 60_000))

    now = new Date(start.getTime() + 13 * 60_000)
    const capped = await protocol.resolve("shr_one", credential.cookieValue, {
      activity: "foreground",
    })
    expect(capped?.expiresAt).toEqual(new Date(start.getTime() + 20 * 60_000))

    now = new Date(start.getTime() + 20 * 60_000)
    await expect(protocol.resolve("shr_one", credential.cookieValue)).resolves.toBeNull()
  })

  test("fails closed for mismatched, revoked, and expired session or grant state", async () => {
    const host = hostWith([BroadShare])
    await seedGrant(host)
    let now = new Date(start)
    const protocol = new SharedSessionProtocol({ host, now: () => now })
    const credential = (await protocol.exchange("shr_one", linkSecret))!
    const [, secret] = credential.cookieValue.split(".")

    await expect(protocol.resolve("shr_one", `shs_missing.${secret}`)).resolves.toBeNull()
    await expect(protocol.resolve("other-grant", credential.cookieValue)).resolves.toBeNull()
    await expect(
      protocol.resolve("shr_one", `${credential.context.sessionId}.${"z".repeat(43)}`)
    ).resolves.toBeNull()

    await protocol.revoke(credential.context)
    await expect(protocol.resolve("shr_one", credential.cookieValue)).resolves.toBeNull()

    const replacement = (await protocol.exchange("shr_one", linkSecret))!
    await host.storage.shareGrants!.revoke({
      projectId: host.id,
      id: "shr_one",
      revokedAt: new Date(now.getTime() + 1),
      revokedBy: { type: "user", id: "manager" },
    })
    await expect(protocol.resolve("shr_one", replacement.cookieValue)).resolves.toBeNull()

    now = new Date(start.getTime() + 2)
  })

  test("intersects with the definition registered now and treats a missing definition as empty", async () => {
    const deps = createTestRuntimeDeps()
    const broadHost = hostWith([BroadShare], deps)
    await seedGrant(broadHost)

    const narrowHost = hostWith([NarrowShare as typeof BroadShare], deps)
    const narrowProtocol = new SharedSessionProtocol({
      host: narrowHost,
      now: () => start,
    })
    const narrowed = await narrowProtocol.exchange("shr_one", linkSecret)
    expect(narrowed?.context.access.grants.some((grant) => grant.kind === "object.view")).toBe(true)
    expect(narrowed?.context.access.grants.some((grant) => grant.kind === "action.apply")).toBe(
      false
    )

    const missingHost = hostWith([], deps)
    const missingProtocol = new SharedSessionProtocol({ host: missingHost, now: () => start })
    const suspended = await missingProtocol.exchange("shr_one", linkSecret)
    expect(suspended?.context.access).toEqual({ grants: [] })
  })
})

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
