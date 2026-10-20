import { describe, expect, test } from "bun:test"
import {
  can,
  defineAction,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  objectRef,
  project,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { getActivityCaptureRuntime } from "@sixb/core/internal/runtime"
import { createTestSixb } from "@sixb/core/testing"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

const Item = defineObjectType({
  id: "Item",
  name: "Item",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const MarkSeen = defineAction("markSeen")
  .on(Item)
  .params({})
  .writeback(() => ({}))
const SharedItem = defineShare("shared-item", {
  target: Item,
  grants: ({ target }) => [can.view(target), can.apply(MarkSeen).on(target)],
})
const observers = defineGroup("observers")
const observer = defineRole("observer", {
  grantedTo: [observers],
  grants: [can.observe(project.activity), can.view(Item), can.share(SharedItem)],
})
const members = defineGroup("members")
const member = defineRole("member", {
  grantedTo: [members],
  grants: [can.view(Item), can.apply(MarkSeen)],
})

const projectId = "activity-routes"
const pageView = { id: "e1", type: "page.view", route: "/items/:id" }

async function createFixture(enabled = true) {
  const storage = new InMemoryStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Item],
    actions: [MarkSeen],
    shares: [SharedItem],
    groups: [observers, members],
    roles: [observer, member],
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" },
    activity: { enabled },
  })
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )

  async function user(userId: string, options: { observer?: boolean; member?: boolean } = {}) {
    await storage.auth.users.create({ projectId, id: userId, email: `${userId}@example.test` })

    const groups = [
      ...(options.observer ? [observers.id] : []),
      ...(options.member ? [members.id] : []),
    ]
    for (const groupId of groups) {
      await storage.auth.groupMemberships.upsert({ projectId, userId, groupId, source: "manual" })
    }
  }

  /** A browser session: its cookie, and the CSRF pair a mutation adds. */
  async function browser(userId: string, options: { observer?: boolean; member?: boolean } = {}) {
    await user(userId, options)
    const credential = createSessionCredential(`ses_${userId}`)
    await storage.auth.sessions.create({
      projectId,
      id: credential.sessionId,
      userId,
      strategyId: "test",
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ipAddress: "203.0.113.7",
    })
    return {
      cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf-token`,
      origin: "http://app.localhost",
      "x-sixb-csrf": "csrf-token",
    }
  }

  /** A native client's session, held as a bearer token. */
  async function native(userId: string) {
    await user(userId)
    const { session, tokens } = host.auth.prepareBearerSession({
      userId,
      clientName: "sixb CLI",
      now: new Date(),
    })
    await storage.auth.sessions.create(session)
    return { authorization: `Bearer ${tokens.accessToken}` }
  }

  const range = `?from=${new Date(Date.now() - 60_000).toISOString()}&to=${new Date(
    Date.now() + 60_000
  ).toISOString()}`

  function post(headers: Record<string, string>, body: unknown = { events: [pageView] }) {
    return app.fetch(
      new Request("http://api.localhost/api/activity/events", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    )
  }

  function get(path: string, headers: Record<string, string> = {}) {
    return app.fetch(new Request(`http://api.localhost/api/activity/${path}`, { headers }))
  }

  function sdkFor(userId: string) {
    return createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: userId },
        groupIds: [],
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
  }

  return { app, host, storage, browser, native, range, post, get, sdkFor }
}

describe("activity routes", () => {
  test("a browser session records its own visit, read back with the observe grant", async () => {
    const fixture = await createFixture()
    const reader = await fixture.browser("reader")
    const viewer = await fixture.browser("viewer", { observer: true })

    expect(await (await fixture.post(reader)).json()).toEqual({ status: "accepted", accepted: 1 })

    expect((await fixture.get(`summary${fixture.range}`)).status).toBe(401)
    expect((await fixture.get(`summary${fixture.range}`, reader)).status).toBe(403)

    const summary = await fixture.get(`summary${fixture.range}`, viewer)
    expect(await summary.json()).toEqual({ users: 1, visits: 1, sharedVisits: 0, pageViews: 1 })

    const page = await (await fixture.get(`visits${fixture.range}`, viewer)).json()
    expect(page.visits[0].actor).toEqual({ type: "user", userId: "reader" })
    // The session id joins activity with other records server-side; it is never read back.
    expect(JSON.stringify(page)).not.toContain("ses_reader")

    const timeline = await (
      await fixture.get(`visits/${page.visits[0].id}/timeline`, viewer)
    ).json()
    expect(timeline.entries).toEqual([
      expect.objectContaining({ kind: "page", sequence: 1, route: "/items/:id" }),
    ])
    // The timeline is the one visit read.
    expect((await fixture.get(`visits/${page.visits[0].id}`, viewer)).status).toBe(404)

    // A browser names neither who it is nor whose visit it adds to.
    const impersonating = { userId: "someone-else", events: [{ ...pageView, id: "e2" }] }
    expect((await fixture.post(reader, impersonating)).status).toBe(422)
  })

  test("a visit's timeline shows the actions its browser session applied", async () => {
    const fixture = await createFixture()
    const reader = await fixture.browser("reader", { member: true })
    const viewer = await fixture.browser("viewer", { observer: true })
    await createTestSixb(fixture.host)
      .objects(Item)
      .upsert({ properties: { id: "one" } })

    await fixture.post(reader)
    const applied = await fixture.app.fetch(
      new Request("http://api.localhost/api/actions/markSeen", {
        method: "POST",
        headers: { ...reader, "content-type": "application/json" },
        body: JSON.stringify({
          subject: { kind: "object", objectTypeId: "Item", primaryId: "one" },
          runId: "act_seen",
        }),
      })
    )
    expect(applied.status).toBe(200)

    const visits = await (await fixture.get(`visits${fixture.range}`, viewer)).json()
    const path = `visits/${visits.visits[0].id}/timeline`
    const timeline = await (await fixture.get(path, viewer)).json()

    expect(timeline.connection).toEqual({
      type: "session",
      device: { browser: "Safari", os: "macOS" },
      status: "active",
      createdAt: expect.any(String),
      lastSeenAt: expect.any(String),
    })
    expect(
      timeline.entries.map(
        ({ at: _at, executionId: _id, ...entry }: { at: string; executionId?: string }) => entry
      )
    ).toEqual([
      { kind: "page", sequence: 1, route: "/items/:id" },
      {
        kind: "action",
        actionId: "markSeen",
        runId: "act_seen",
        status: "succeeded",
        runVisible: false,
        object: { objectTypeId: "Item", primaryId: "one" },
      },
    ])
    expect(timeline.truncated).toBe(false)
    for (const hidden of ["ses_reader", "203.0.113.7", "Mozilla"]) {
      expect(JSON.stringify(timeline)).not.toContain(hidden)
    }

    expect((await fixture.get(path, reader)).status).toBe(403)
    expect((await fixture.get("visits/visit_missing/timeline", viewer)).status).toBe(404)
  })

  test("a user's connections list their sign-ins with the visits each opened", async () => {
    const fixture = await createFixture()
    const reader = await fixture.browser("reader")
    const viewer = await fixture.browser("viewer", { observer: true })
    await fixture.post(reader)

    const visits = await (await fixture.get(`visits${fixture.range}`, viewer)).json()
    const response = await fixture.get("connections?userId=reader", viewer)
    const page = await response.json()

    expect(page).toEqual({
      connections: [
        {
          type: "session",
          device: { browser: "Safari", os: "macOS" },
          status: "active",
          createdAt: expect.any(String),
          lastSeenAt: expect.any(String),
          visits: 1,
          latestVisits: [expect.objectContaining({ id: visits.visits[0].id, pageViews: 1 })],
        },
      ],
    })
    for (const hidden of ["ses_reader", "203.0.113.7", "Mozilla"]) {
      expect(JSON.stringify(page)).not.toContain(hidden)
    }

    expect((await fixture.get("connections?userId=reader", reader)).status).toBe(403)
    expect(
      (await fixture.get("connections?userId=reader&cursor=not%20a%20cursor", viewer)).status
    ).toBe(422)
    expect((await fixture.get("connections?userId=reader&cursor=bm9wZQ", viewer)).status).toBe(400)
    expect((await fixture.get("connections?userId=", viewer)).status).toBe(422)
  })

  // Guard proof: drop the credentialTransport check in assertBrowserCapture; the native session
  // records a visit.
  test("a native client's bearer session records nothing", async () => {
    const fixture = await createFixture()
    const cli = await fixture.native("cli-user")

    expect((await fixture.get("capture-config", cli)).status).toBe(403)
    expect((await fixture.post(cli)).status).toBe(403)
    expect(
      (
        await fixture.storage.activity.summarize({
          projectId,
          from: new Date(Date.now() - 60_000),
          to: new Date(Date.now() + 60_000),
        })
      ).visits
    ).toBe(0)
  })

  test("capture validates attribution and keeps the first arrival on the visit", async () => {
    const fixture = await createFixture()
    const reader = await fixture.browser("reader")
    const viewer = await fixture.browser("viewer", { observer: true })
    const arrival = { id: "arrival", type: "page.view", route: "/" }

    for (const attribution of [
      { source: "x".repeat(101) },
      { referrer: "https://example.com/secret" },
      { secret: "no" },
      { medium: "bad\nvalue" },
    ]) {
      const response = await fixture.post(reader, { events: [{ ...arrival, attribution }] })
      expect(response.status).toBe(422)
    }

    const attribution = { medium: "email", campaign: "launch" }
    expect((await fixture.post(reader, { events: [{ ...arrival, attribution }] })).status).toBe(200)

    const page = await (await fixture.get(`visits${fixture.range}`, viewer)).json()
    expect(page.visits[0].attribution).toEqual(attribution)
  })

  test("user filters keep the observe grant and reject blank users", async () => {
    const fixture = await createFixture()
    const userA = await fixture.browser("user-a")
    const userB = await fixture.browser("user-b")
    const viewer = await fixture.browser("viewer", { observer: true })
    await fixture.post(userA)
    await fixture.post(userB)

    const filtered = `${fixture.range}&userId=user-a`
    expect(await (await fixture.get(`summary${filtered}`, viewer)).json()).toEqual({
      users: 1,
      visits: 1,
      sharedVisits: 0,
      pageViews: 1,
    })

    const visits = await (await fixture.get(`visits${filtered}`, viewer)).json()
    expect(visits.visits.map((visit: { actor: unknown }) => visit.actor)).toEqual([
      { type: "user", userId: "user-a" },
    ])

    expect((await fixture.get(`visits${filtered}`, userA)).status).toBe(403)
    expect((await fixture.get(`visits${fixture.range}&userId=`, viewer)).status).toBe(422)
    expect((await fixture.get(`summary${fixture.range}&userId=%20`, viewer)).status).toBe(422)
  })

  test("the user list resolves display names only, and only for observers", async () => {
    const fixture = await createFixture()
    const userA = await fixture.browser("user-a")
    const viewer = await fixture.browser("viewer", { observer: true })
    await fixture.storage.auth.users.updateProfile({ projectId, id: "user-a", displayName: "Alex" })
    await fixture.post(userA)

    const page = await (await fixture.get(`users${fixture.range}`, viewer)).json()
    expect(page).toEqual({
      users: [
        expect.objectContaining({ userId: "user-a", displayName: "Alex", visits: 1, pageViews: 1 }),
      ],
      hasMore: false,
    })
    expect(JSON.stringify(page)).not.toContain("@example.test")
    expect((await fixture.get(`users${fixture.range}`, userA)).status).toBe(403)
  })

  test("the calendar is one user's UTC year, behind the observe grant", async () => {
    const fixture = await createFixture()
    const userA = await fixture.browser("user-a")
    const viewer = await fixture.browser("viewer", { observer: true })
    await fixture.post(userA)

    const year = new Date().getUTCFullYear()
    const path = `calendar?userId=user-a&year=${year}`
    expect(await (await fixture.get(path, viewer)).json()).toEqual({
      userId: "user-a",
      year,
      days: [{ day: new Date().toISOString().slice(0, 10), visits: 1, pageViews: 1 }],
    })
    expect((await fixture.get(path, userA)).status).toBe(403)
    expect((await fixture.get("calendar?userId=user-a&year=2026.5", viewer)).status).toBe(422)
  })

  test("interactions are recorded by name, shown in sequence, and refused unnamed", async () => {
    const fixture = await createFixture()
    const reader = await fixture.browser("reader")
    const viewer = await fixture.browser("viewer", { observer: true })
    const click = { id: "c1", type: "ui.interaction", name: "items.export", route: "/items/:id" }

    for (const invalid of [
      { ...click, name: "Items.Export" },
      { ...click, name: "items.42" },
      { ...click, name: "items.row1234" },
      { ...click, name: "x".repeat(101) },
      { ...click, attribution: {} },
      { ...click, text: "Export" },
      { id: "c1", type: "ui.interaction", route: "/items/:id" },
    ]) {
      // The whole batch is refused, so the valid page view beside it is not recorded either.
      expect((await fixture.post(reader, { events: [pageView, invalid] })).status).toBe(422)
    }

    expect(await (await fixture.post(reader, { events: [pageView, click] })).json()).toEqual({
      status: "accepted",
      accepted: 2,
    })

    const visits = await (await fixture.get(`visits${fixture.range}`, viewer)).json()
    expect(visits.visits).toHaveLength(1)
    expect(visits.visits[0]).toMatchObject({ pageViews: 1, interactions: 1 })

    const path = `visits/${visits.visits[0].id}/timeline`
    const timeline = await (await fixture.get(path, viewer)).json()
    expect(timeline.entries.map(({ at: _at, ...entry }: { at: string }) => entry)).toEqual([
      { kind: "page", sequence: 1, route: "/items/:id" },
      { kind: "interaction", sequence: 2, name: "items.export", route: "/items/:id" },
    ])
  })

  test("capture refuses a missing CSRF token, unknown fields and concrete URLs", async () => {
    const fixture = await createFixture()
    const reader = await fixture.browser("reader")
    const { "x-sixb-csrf": _csrf, ...withoutCsrf } = reader

    expect((await fixture.post(withoutCsrf)).status).toBe(403)

    const concrete = { events: [{ ...pageView, route: "/items/123?secret=value" }] }
    expect((await fixture.post(reader, concrete)).status).toBe(422)

    const extra = { events: [{ ...pageView, text: "sensitive" }] }
    expect((await fixture.post(reader, extra)).status).toBe(422)
  })

  test("disabled collection records nothing and history stays readable", async () => {
    const fixture = await createFixture(false)
    const reader = await fixture.browser("reader")
    const viewer = await fixture.browser("viewer", { observer: true })

    expect(await (await fixture.get("capture-config", reader)).json()).toEqual({
      enabled: false,
      idleTimeoutMs: 30 * 60_000,
    })
    expect(await (await fixture.post(reader)).json()).toEqual({ status: "disabled", accepted: 0 })
    expect((await (await fixture.get(`summary${fixture.range}`, viewer)).json()).visits).toBe(0)
  })

  // Guard proof: remove assertObservable() from list in activity/execution.ts.
  test("the execution SDK enforces the observe grant without HTTP", async () => {
    const fixture = await createFixture()
    const period = { from: new Date(Date.now() - 1_000), to: new Date() }

    await expect(fixture.sdkFor("reader").activity.list(period)).rejects.toThrow("not allowed")
    await expect(fixture.sdkFor("reader").activity.users(period)).rejects.toThrow("not allowed")
    await expect(
      fixture.sdkFor("reader").activity.calendar({ userId: "reader", year: 2026 })
    ).rejects.toThrow("not allowed")

    // Project code cannot record: the SDK has no capture, and a trusted execution is no session.
    const trusted = createTestSixb(fixture.host)
    expect(Object.keys(trusted.activity).sort()).toEqual([
      "calendar",
      "connections",
      "list",
      "summarize",
      "timeline",
      "users",
    ])
    await expect(
      getActivityCaptureRuntime(trusted).capture([{ id: "e1", type: "page.view", route: "/" }])
    ).rejects.toThrow("only for a signed-in user's session")
  })

  test("a shared-link session records an anonymous visit and cannot read activity", async () => {
    const fixture = await createFixture()
    const ambient = await fixture.browser("viewer", { observer: true })
    await createTestSixb(fixture.host)
      .objects(Item)
      .upsert({ properties: { id: "one" } })

    const issuer = createTestSixb(fixture.host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: "viewer" },
        groupIds: [observers.id],
        roles: fixture.host.definitions.security.listResolvedRoles(),
      }),
    })
    const invitation = await issuer.shares.issue(SharedItem, {
      target: objectRef(Item, "one"),
      destinationPath: "/items/one",
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    const exchange = await fixture.app.fetch(
      new Request(`http://api.localhost/api/shared-access/${invitation.grant.id}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: invitation.secret }),
      })
    )
    expect(exchange.status).toBe(200)
    const { csrfToken } = await exchange.json()
    const sharedCookies = exchange.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")

    // The selected grant wins over the ambient browser session sent alongside it.
    const shared = {
      cookie: `${sharedCookies}; ${ambient.cookie}`,
      origin: "http://app.localhost",
      "x-sixb-share-grant": invitation.grant.id,
      "x-sixb-csrf": csrfToken,
    }
    expect((await fixture.post(shared)).status).toBe(200)
    expect((await fixture.get(`summary${fixture.range}`, shared)).status).toBe(403)

    // An action the visitor applies through the link is the shared visit's.
    const applied = await fixture.app.fetch(
      new Request("http://api.localhost/api/actions/markSeen", {
        method: "POST",
        headers: { ...shared, "content-type": "application/json" },
        body: JSON.stringify({
          subject: { kind: "object", objectTypeId: "Item", primaryId: "one" },
          runId: "act_shared",
        }),
      })
    )
    expect(applied.status).toBe(200)

    const page = await (await fixture.get(`visits${fixture.range}`, ambient)).json()
    // The visit names the link's share, read with the visits; never the session.
    expect(page.visits.map((visit: { actor: unknown }) => visit.actor)).toEqual([
      { type: "share", grantId: invitation.grant.id, definitionId: "shared-item" },
    ])
    const timeline = await (
      await fixture.get(`visits/${page.visits[0].id}/timeline`, ambient)
    ).json()
    expect(timeline.visit.actor.definitionId).toBe("shared-item")
    expect(
      timeline.entries.flatMap((entry: { kind: string; runId?: string }) =>
        entry.kind === "action" ? [entry.runId] : []
      )
    ).toEqual(["act_shared"])
    expect(timeline.connection).toMatchObject({
      type: "share",
      grantId: invitation.grant.id,
      definitionId: "shared-item",
      status: "active",
    })
    expect((await (await fixture.get(`summary${fixture.range}`, ambient)).json()).users).toBe(0)

    await issuer.shares.revoke(invitation.grant.id)
    expect((await fixture.post(shared, { events: [{ ...pageView, id: "e2" }] })).status).toBe(401)

    // Revoking the link ends its session too, as its connection says.
    const revoked = await (
      await fixture.get(`visits/${page.visits[0].id}/timeline`, ambient)
    ).json()
    expect(revoked.connection).toMatchObject({ type: "share", status: "revoked" })
    expect(revoked.connection.revokedAt).toEqual(expect.any(String))
  })
})
