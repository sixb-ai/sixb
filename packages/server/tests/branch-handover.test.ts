import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  project,
  prop,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import type { OidcAuthStrategy } from "@sixb/core/auth/strategy"
import { createSessionCredential } from "@sixb/core/internal/auth"
import {
  BRANCH_HANDOVER_CODE_TTL_MS,
  BRANCH_KEY_HEADER,
  branchNamespaceName,
  hostOnBranch,
} from "@sixb/core/internal/branches"
import { putOnBranch } from "@sixb/core/internal/runtime"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Production lets Ada into a branch it runs: it asks the branch, with the branch's key, for a
// one-time code, and Ada's browser trades the code on the branch's origin for a session there.

const projectId = "shop"
const KEY = "k".repeat(43)
const Order = defineObjectType({
  id: "order",
  name: "Order",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const developers = defineGroup("developers")
const roles = [
  defineRole("developers", {
    grantedTo: [developers],
    grants: [can.view(Order), can.manage(project.source)],
  }),
]
const ada = {
  id: "usr_ada",
  email: "ada@shop.test",
  displayName: "Ada",
  groupIds: ["developers"],
}

const stops: (() => Promise<unknown>)[] = []
afterEach(async () => {
  jest.useRealTimers()
  for (const stop of stops.splice(0)) await stop()
})

function options(storage: InMemoryStorage, overrides: Partial<SixbHostOptions> = {}) {
  return {
    id: projectId,
    ontology: [Order],
    groups: [developers],
    roles,
    auth: { id: "test", kind: "dev" as const },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    ...overrides,
  }
}

/** A branch production runs: on its own storage, with the key production's requests carry. */
function branchApp(
  origin = "http://branch.localhost",
  overrides: Partial<SixbHostOptions> = {},
  allowedOrigins: readonly string[] = [origin]
) {
  const storage = new InMemoryStorage()
  const project = new SixbHost(
    putOnBranch(options(new InMemoryStorage(), overrides), {
      name: "feature/invoices",
      dataFrom: "production",
    })
  )
  const host = hostOnBranch(project, {
    storage,
    runtime: {
      person: { userId: "usr_bo" },
      production: {
        url: "https://api.shop.test",
        authorization: async () => "Bearer sixb_branch_x",
      },
      takenAt: "2026-11-25T08:00:00.000Z",
      hosted: { key: KEY },
    },
  })
  const server = new SixbServer({
    host,
    quiet: true,
    browser: { publicOrigin: origin, allowedOrigins },
  })
  return { app: createSixbApi(server), server, storage, origin }
}

async function prepare(app: ReturnType<typeof createSixbApi>, key = KEY, person = ada) {
  return app.fetch(
    new Request("http://branch.localhost/api/branch-handover", {
      method: "POST",
      headers: { "content-type": "application/json", [BRANCH_KEY_HEADER]: key },
      body: JSON.stringify(person),
    })
  )
}

async function exchange(app: ReturnType<typeof createSixbApi>, code: string) {
  return app.fetch(
    new Request(`http://branch.localhost/auth/branch-handover?code=${encodeURIComponent(code)}`, {
      redirect: "manual",
    })
  )
}

/** The cookies a response set, as a browser sends them back. */
function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ")
}

async function sessionOf(app: ReturnType<typeof createSixbApi>, cookie: string) {
  const response = await app.fetch(
    new Request("http://branch.localhost/api/auth/session", { headers: { cookie } })
  )
  return (await response.json()) as { authenticated?: boolean; user?: { id: string } }
}

describe("a branch's handover", () => {
  // Guard check: return true from `fromProduction` (`routes/branch-handover.ts`).
  test("prepares a session only for production, which holds the branch's key", async () => {
    const { app, storage } = branchApp()

    expect((await prepare(app, "x".repeat(43))).status).toBe(401)
    expect(await storage.auth.users.getById({ projectId, id: ada.id })).toBeNull()

    const prepared = await prepare(app)
    expect(prepared.status).toBe(200)
    expect(await prepared.json()).toMatchObject({ code: expect.any(String) })
    // Ada joined production after the copy: the branch makes her a member, in her groups.
    expect(await storage.auth.users.getById({ projectId, id: ada.id })).toMatchObject({
      email: ada.email,
    })
    const groups = await storage.auth.groupMemberships.listForUser({ projectId, userId: ada.id })
    expect(groups.map((membership) => membership.groupId)).toEqual(["developers"])
  })

  // Guard check: leave the code in `codes` after `exchange` (`branches/handover.ts`).
  test("trades a code once, for a session of the person it was made for", async () => {
    const { app } = branchApp()
    const { code } = (await (await prepare(app)).json()) as { code: string }

    const first = await exchange(app, code)
    expect(first.headers.getSetCookie().length).toBeGreaterThanOrEqual(2)
    expect(await sessionOf(app, cookiesOf(first))).toMatchObject({
      authenticated: true,
      user: { id: ada.id },
    })

    const again = await exchange(app, code)
    expect(again.status).toBe(400)
    expect(again.headers.getSetCookie()).toEqual([])
  })

  // Guard check: drop the `expiresAt` check from `exchange` (`branches/handover.ts`).
  test("refuses a code past its minute", async () => {
    jest.useFakeTimers({ now: new Date("2026-11-25T12:00:00.000Z") })
    const { app } = branchApp()
    const { code } = (await (await prepare(app)).json()) as { code: string }

    jest.advanceTimersByTime(BRANCH_HANDOVER_CODE_TTL_MS + 1)

    expect((await exchange(app, code)).status).toBe(400)
  })

  test("refuses a code another branch made", async () => {
    const first = branchApp()
    const second = branchApp()
    const { code } = (await (await prepare(first.app)).json()) as { code: string }

    expect((await exchange(second.app, code)).status).toBe(400)
    expect((await exchange(first.app, code)).headers.getSetCookie().length).toBeGreaterThan(0)
  })

  // The branch is signed into by the handover alone: its project's own strategy signs nobody in.
  // The project signs people in through its identity provider; on the branch, nobody is sent
  // there. Keeping the project's strategy on a hosted branch (`runtime/host.ts`) turns this red.
  test("signs nobody in any other way", async () => {
    const started: unknown[] = []
    const strategy: OidcAuthStrategy = {
      id: "entra",
      kind: "oidc",
      async startOidcSignIn(input) {
        started.push(input)
        return { redirectTo: "https://idp.test/authorize", state: "state", expiresAt: new Date() }
      },
      async completeOidcSignIn(): Promise<never> {
        throw new Error("unused")
      },
      async deliverInvitation() {
        return { status: "sent" }
      },
      providerProfileFields: () => [],
    }
    const { app } = branchApp("http://branch.localhost", { auth: strategy })

    const tried = await app.fetch(
      new Request("http://branch.localhost/auth/sign-in?returnTo=http://branch.localhost/")
    )

    expect(tried.status).toBeGreaterThanOrEqual(400)
    expect(started).toEqual([])

    // Nor does a request run as the branch's creator, as on a laptop: it takes a session here.
    // Guard check: drop `runtime.hosted` from `branchPersonContext` (`server.ts`).
    const anonymous = await app.fetch(
      new Request("http://branch.localhost/api/objects?objectTypeId=order")
    )
    expect(anonymous.status).toBe(401)
  })

  // A session from the handover is a session like any other: its writes need its CSRF token.
  test("holds the branch's own session to CSRF, on the branch's origin", async () => {
    const { app } = branchApp()
    const { code } = (await (await prepare(app)).json()) as { code: string }
    const cookie = cookiesOf(await exchange(app, code))
    const csrf = /sixb_csrf_app=([^;]+)/.exec(cookie)?.[1] ?? ""
    const query = (headers: Record<string, string>) =>
      app.fetch(
        new Request("http://branch.localhost/api/objects/query", {
          method: "POST",
          headers: {
            cookie,
            origin: "http://branch.localhost",
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify({ objectTypeId: Order.id }),
        })
      )

    expect((await query({})).status).toBe(403)
    // Past the CSRF check, the query itself answers.
    expect((await query({ "x-sixb-csrf": csrf })).status).not.toBe(403)
  })
})

describe("a branch's origin", () => {
  // Guard check: return `policy` whatever the host, in `ownOriginOnBranch` (`server.ts`).
  test("answers browsers on its own origin only, sockets included", async () => {
    const preview = "https://feature-invoices.preview.shop.test"
    const production = "https://app.shop.test"
    // Given production's origin too, the branch admits only its own.
    const { app } = branchApp(preview, {}, [preview, production])
    const from = (origin: string, path = "/api/auth/session", headers = {}) =>
      app.fetch(new Request(`${preview}${path}`, { headers: { origin, ...headers } }))
    const upgrade = { connection: "upgrade", upgrade: "websocket" }

    expect((await from(preview)).status).toBe(200)
    expect((await from(production)).status).toBe(403)
    expect((await from("https://elsewhere.example")).status).toBe(403)

    expect((await from(production, "/ws/events", upgrade)).status).toBe(403)
    expect((await from(preview, "/ws/events", upgrade)).status).not.toBe(403)
  })
})

describe("signing into a branch from production", () => {
  // Production's half and the branch's, end to end over HTTP: the person production names is the
  // one the branch signs in.
  test("returns a one-time URL on the branch's origin, for the person who asked", async () => {
    const branch = branchApp()
    await branch.server.start()
    stops.push(() => branch.server.stop({ timeoutMs: 0 }))
    const branchUrl = `http://127.0.0.1:${branch.server.getPort()}`

    const storage = new InMemoryStorage()
    const production = new SixbHost(options(storage, { source: { repository: "acme/shop" } }))
    const app = createSixbApi(
      new SixbServer({ host: production, quiet: true, browser: createTestBrowserPolicy() })
    )
    const headers = await signIn(storage)
    await storage.hostedBranches.create(readyBranch(branchUrl))

    const answer = await app.fetch(
      new Request("http://localhost/api/branches/sign-in", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "feature/invoices" }),
      })
    )
    const { url } = (await answer.json()) as { url: string }
    expect(new URL(url).origin).toBe(branchUrl)

    const signedIn = await fetch(url, { redirect: "manual" })
    expect(await sessionOf(branch.app, cookiesOf(signedIn))).toMatchObject({
      user: { id: ada.id },
    })
  })

  // A preview host is the branch's: production forwards it whole, and keeps the key to itself.
  // Guard check: return null from `forwardToPreview` (`routes/branch-preview.ts`).
  test("forwards a branch's preview host to the branch, without production's key", async () => {
    const seen: { readonly path: string; readonly key: string | null }[] = []
    const fake = Bun.serve({
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url)
        seen.push({ path: url.pathname + url.search, key: request.headers.get(BRANCH_KEY_HEADER) })
        return new Response("from the branch")
      },
    })
    stops.push(async () => fake.stop(true))

    const storage = new InMemoryStorage()
    const production = new SixbHost(
      options(storage, { source: { repository: "acme/shop", previewDomain: "preview.shop.test" } })
    )
    const server = new SixbServer({
      host: production,
      quiet: true,
      port: 0,
      hostname: "127.0.0.1",
      browser: createTestBrowserPolicy(),
    })
    await server.start()
    stops.push(() => server.stop({ timeoutMs: 0 }))
    await storage.hostedBranches.create(readyBranch(`http://127.0.0.1:${fake.port}`))

    const namespace = branchNamespaceName("feature/invoices")
    const answer = await fetch(`http://127.0.0.1:${server.getPort()}/invoices?page=2`, {
      headers: { host: `${namespace}.preview.shop.test`, [BRANCH_KEY_HEADER]: "forged" },
    })

    expect(await answer.text()).toBe("from the branch")
    expect(seen).toEqual([{ path: "/invoices?page=2", key: null }])
  })

  // Guard check: return the domain whatever `cookieDomain` covers in `capturePreviewDomain`.
  test("refuses a preview domain production's cookies would reach", () => {
    const storage = new InMemoryStorage()

    expect(
      () =>
        new SixbHost(
          options(storage, {
            source: { repository: "acme/shop", previewDomain: "preview.shop.test" },
            auth: {
              strategy: { id: "test", kind: "dev" },
              cookies: { cookieDomain: ".shop.test" },
            },
          })
        )
    ).toThrow("inside production's cookieDomain")
  })
})

async function signIn(storage: InMemoryStorage) {
  const credential = createSessionCredential(`ses_${ada.id}`)
  await storage.auth.users.create({
    id: ada.id,
    projectId,
    email: ada.email,
    displayName: ada.displayName,
  })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId: ada.id,
    groupId: "developers",
    source: "manual",
  })
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId: ada.id,
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date(),
    expiresAt: new Date("2099-11-24T10:00:00.000Z"),
  })
  return {
    cookie: `sixb_session_app=${credential.cookieValue}; sixb_csrf_app=csrf_1`,
    "x-sixb-csrf": "csrf_1",
    "content-type": "application/json",
  }
}

function readyBranch(url: string) {
  const at = new Date()
  return {
    projectId,
    name: "feature/invoices",
    namespace: branchNamespaceName("feature/invoices"),
    wanted: "running" as const,
    state: "ready" as const,
    createdBy: ada.id,
    key: KEY,
    port: 20_000,
    sandbox: null,
    url,
    generation: 1,
    commit: null,
    error: null,
    data: null,
    refreshRequestedAt: null,
    remoteCommit: "a".repeat(40),
    remoteError: null,
    notices: [],
    owner: "worker",
    leaseExpiresAt: new Date(at.getTime() + 60_000),
    createdAt: at,
    openedAt: at,
    lastSeenAt: at,
  }
}
