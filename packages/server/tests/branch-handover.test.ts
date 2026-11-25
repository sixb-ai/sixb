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
  BRANCH_SESSION_MAX_MS,
  branchHandoverAuth,
  branchNamespaceName,
  hostOnBranch,
  siteOf,
} from "@sixb/core/internal/branches"
import { putOnBranch } from "@sixb/core/internal/runtime"
import type { BranchRecord } from "@sixb/core/storage"
import {
  BRANCH_PREVIEW_HEADERS_TIMEOUT_MS,
  BRANCH_PREVIEW_MAX_IN_FLIGHT,
} from "../src/routes/branch-preview"
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
      hosted: { key: KEY, origin },
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

  // Production let Ada in as an active member of "developers" alone: the copy, older, may hold her
  // suspended and in another group. Guard check: drop the `updateStatus` call, or the `remove`
  // loop, from `ensureMember` (`branches/handover.ts`).
  test("lets the person in as production has them now, whatever the copy says", async () => {
    const { app, storage } = branchApp()
    await storage.auth.users.create({ projectId, id: ada.id, email: ada.email })
    await storage.auth.users.updateStatus({ projectId, id: ada.id, status: "suspended" })
    await storage.auth.groupMemberships.upsert({
      projectId,
      userId: ada.id,
      groupId: "admins",
      source: "manual",
    })

    const { code } = (await (await prepare(app)).json()) as { code: string }
    expect(await sessionOf(app, cookiesOf(await exchange(app, code)))).toMatchObject({
      authenticated: true,
      user: { id: ada.id },
    })
    expect((await storage.auth.users.getById({ projectId, id: ada.id }))?.status).toBe("active")
    const groups = await storage.auth.groupMemberships.listForUser({ projectId, userId: ada.id })
    expect(groups.map((membership) => membership.groupId)).toEqual(["developers"])
  })

  // Production checks the grant only at the handover: losing it reaches the branch within hours.
  // Guard check: keep the project's `absoluteTimeoutMs` in `branchHandoverAuth`.
  test("ends the branch's session within four hours, however active", async () => {
    const { app, storage } = branchApp()
    const { code } = (await (await prepare(app)).json()) as { code: string }
    await exchange(app, code)

    const [session] = await storage.auth.sessions.listActiveByUserId({
      projectId,
      userId: ada.id,
      now: new Date(),
    })
    const lifetime =
      (session?.absoluteExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY) -
      (session?.createdAt.getTime() ?? 0)
    expect(lifetime).toBe(BRANCH_SESSION_MAX_MS)
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

describe("a branch's credentials", () => {
  // Red check: drop `assertMakesAccessTokens` from `createPersonalAccessToken` (`auth/runtime.ts`):
  // the token is made, and outlives the session's 4 hours and the grant.
  test("makes no access token: nothing outlives a session production let in", async () => {
    const { app } = branchApp()
    const { code } = (await (await prepare(app)).json()) as { code: string }
    const cookie = cookiesOf(await exchange(app, code))
    const csrf = /sixb_csrf_app=([^;]+)/.exec(cookie)?.[1] ?? ""

    const minted = await app.fetch(
      new Request("http://branch.localhost/api/auth/access-tokens", {
        method: "POST",
        headers: {
          cookie,
          origin: "http://branch.localhost",
          "content-type": "application/json",
          "x-sixb-csrf": csrf,
        },
        body: JSON.stringify({
          name: "laptop",
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        }),
      })
    )

    expect(minted.status).toBe(403)
    expect(await minted.text()).toContain("makes no access tokens")
  })

  // The project lets its sessions last 30 days; a branch's still end at 4 hours.
  // Red check: return the project's `session` as it is from `branchHandoverAuth`.
  test("ends a session at 4 hours, whatever the project's session length", async () => {
    const now = new Date("2026-11-25T08:00:00.000Z")
    jest.useFakeTimers({ now })
    const { app } = branchApp("http://branch.localhost", {
      auth: {
        strategy: { id: "test", kind: "dev" },
        session: { absoluteTimeoutMs: 30 * 86_400_000, idleTimeoutMs: 14 * 86_400_000 },
      },
    })
    const { code } = (await (await prepare(app)).json()) as { code: string }
    const cookie = cookiesOf(await exchange(app, code))
    expect((await sessionOf(app, cookie)).authenticated).toBe(true)

    jest.setSystemTime(new Date(now.getTime() + BRANCH_SESSION_MAX_MS + 60_000))
    expect((await sessionOf(app, cookie)).authenticated).not.toBe(true)
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

  // The branch's refusal is about the person: production says it rather than a status code.
  test("says why the branch did not let the person in", async () => {
    const branch = branchApp()
    await branch.server.start()
    stops.push(() => branch.server.stop({ timeoutMs: 0 }))

    const storage = new InMemoryStorage()
    const production = new SixbHost(options(storage, { source: { repository: "acme/shop" } }))
    const app = createSixbApi(
      new SixbServer({ host: production, quiet: true, browser: createTestBrowserPolicy() })
    )
    const headers = await signIn(storage)
    await storage.hostedBranches.create({
      ...readyBranch(`http://127.0.0.1:${branch.server.getPort()}`),
      key: "x".repeat(43),
    })

    const answer = await app.fetch(
      new Request("http://localhost/api/branches/sign-in", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "feature/invoices" }),
      })
    )
    expect(await answer.json()).toMatchObject({
      error: expect.stringContaining("Only production prepares a session here."),
    })
  })

  // The branch's code answers production's request, from production's network: a redirect it
  // gives must reach nothing there. Red check: drop `redirect: "error"` from `signIn`
  // (`branches/execution.ts`): production posts the key and Ada to the internal server.
  test("follows no redirect the branch answers with", async () => {
    const reached: Request[] = []
    const internal = Bun.serve({
      port: 0,
      fetch: (request) => {
        reached.push(request)
        return Response.json({ code: "from-inside" })
      },
    })
    stops.push(async () => internal.stop(true))
    const branch = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${internal.port}/admin` },
        }),
    })
    stops.push(async () => branch.stop(true))

    const storage = new InMemoryStorage()
    const production = new SixbHost(options(storage, { source: { repository: "acme/shop" } }))
    const app = createSixbApi(
      new SixbServer({ host: production, quiet: true, browser: createTestBrowserPolicy() })
    )
    const headers = await signIn(storage)
    await storage.hostedBranches.create(readyBranch(`http://127.0.0.1:${branch.port}`))

    const answer = await app.fetch(
      new Request("http://localhost/api/branches/sign-in", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "feature/invoices" }),
      })
    )

    expect(reached).toHaveLength(0)
    expect(answer.ok).toBe(false)
    expect(await answer.json()).toMatchObject({
      error: expect.stringContaining("answered with a redirect, which production never follows"),
    })
  })
})

describe("a branch's server", () => {
  // Its API sees plain http from the front: the public origin says https.
  // Guard check: drop `secure` from `branchHandoverAuth`.
  test("sends its cookies Secure when people reach it over https", () => {
    const auth = branchHandoverAuth(
      { id: "test", kind: "dev" },
      "https://feature-x.shop-preview.dev"
    )
    expect("cookies" in auth ? auth.cookies : undefined).toMatchObject({
      secure: true,
      cookieDomain: undefined,
    })
    const local = branchHandoverAuth({ id: "test", kind: "dev" }, "http://127.0.0.1:20000")
    expect("cookies" in local ? local.cookies?.secure : undefined).toBeUndefined()
  })
})

describe("a branch's preview host", () => {
  /**
   * Production with `preview.shop.test` as its preview domain, and a branch answering through
   * `fetch`. `call` asks production for a host under the preview domain.
   */
  async function previewLab(
    fetchBranch: (
      request: Request,
      server: Bun.Server<undefined>
    ) => Response | Promise<Response> | undefined,
    branch: Partial<Pick<BranchRecord, "state">> = {},
    websocket?: Bun.WebSocketHandler<undefined>
  ) {
    const fake = Bun.serve<undefined>({
      port: 0,
      fetch: fetchBranch,
      ...(websocket ? { websocket } : {}),
    } as never)
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
    await storage.hostedBranches.create({
      ...readyBranch(`http://127.0.0.1:${fake.port}`),
      ...branch,
    })

    const namespace = branchNamespaceName("feature/invoices")
    const origin = `http://127.0.0.1:${server.getPort()}`
    const call = (host: string, path = "/", init: RequestInit = {}) =>
      fetch(`${origin}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), host },
      })
    return { call, namespace, origin, branchHost: `${namespace}.preview.shop.test` }
  }

  // Guard check: return null from `BranchPreview.fetch` (`routes/branch-preview.ts`).
  test("forwards a branch's host to the branch, without production's key", async () => {
    const seen: { readonly path: string; readonly key: string | null }[] = []
    const { call, branchHost } = await previewLab((request) => {
      const url = new URL(request.url)
      seen.push({ path: url.pathname + url.search, key: request.headers.get(BRANCH_KEY_HEADER) })
      return new Response("from the branch")
    })

    const answer = await call(branchHost, "/invoices?page=2", {
      headers: { [BRANCH_KEY_HEADER]: "forged" },
    })

    expect(await answer.text()).toBe("from the branch")
    expect(seen).toEqual([{ path: "/invoices?page=2", key: null }])
  })

  // Nothing under the preview domain is production's, whatever its shape. Guard check: return
  // null for "other" in `BranchPreview.fetch`.
  test("answers 404 for any other host under the preview domain, never production", async () => {
    const { call, namespace } = await previewLab(() => new Response("from the branch"))

    for (const host of [
      "preview.shop.test",
      `a.${namespace}.preview.shop.test`,
      "unknown.preview.shop.test",
    ]) {
      const answer = await call(host, "/api/project")
      expect({ host, status: answer.status }).toEqual({ host, status: 404 })
    }
    expect(await (await call(`${namespace}.preview.shop.test.`)).text()).toBe("from the branch")
  })

  test("says a branch that is starting is starting", async () => {
    const { call, branchHost } = await previewLab(() => new Response("from the branch"), {
      state: "starting",
    })

    const answer = await call(branchHost)
    expect(answer.status).toBe(503)
    expect(await answer.text()).toContain("starting")
  })

  // Branch code answers these, so branches share a bounded number of production's connections.
  // Guard check: return a slot from `acquire` whatever `inFlight` is.
  test("holds at most 64 requests for branches at once", async () => {
    const held: (() => void)[] = []
    let full!: () => void
    const allHeld = new Promise<void>((resolve) => {
      full = resolve
    })
    let holding = true
    const { call, branchHost } = await previewLab((): Response | Promise<Response> => {
      if (!holding) return new Response("now")
      return new Promise<Response>((resolve) => {
        held.push(() => resolve(new Response("late")))
        if (held.length === BRANCH_PREVIEW_MAX_IN_FLIGHT) full()
      })
    })

    const waiting = Array.from({ length: BRANCH_PREVIEW_MAX_IN_FLIGHT }, () => call(branchHost))
    await allHeld

    expect((await call(branchHost)).status).toBe(503)
    holding = false
    for (const release of held) release()
    await Promise.all(waiting.map(async (answer) => (await answer).text()))
    expect((await call(branchHost)).status).toBe(200)
  })

  // Guard check: drop the headers timer from `BranchPreview.forward`.
  test("gives a branch 30 s to start answering", async () => {
    let asked!: () => void
    const reached = new Promise<void>((resolve) => {
      asked = resolve
    })
    const { call, branchHost } = await previewLab(() => {
      asked()
      return new Promise<Response>(() => {})
    })
    jest.useFakeTimers()

    const answer = call(branchHost)
    await reached
    jest.advanceTimersByTime(BRANCH_PREVIEW_HEADERS_TIMEOUT_MS)

    expect((await answer).status).toBe(504)
  })

  // Agent streaming, live artifacts and logs reach the branch through its socket. Guard check:
  // drop the upgrade from `BranchPreview.forward`.
  test("forwards a branch page's WebSocket to the branch", async () => {
    const { origin, branchHost } = await previewLab(
      (request, server) =>
        server.upgrade(request) ? undefined : new Response("no", { status: 400 }),
      {},
      {
        message: (ws, message) => {
          ws.send(`branch: ${message}`)
        },
      }
    )

    const socket = new WebSocket(`${origin.replace("http", "ws")}/ws/agents`, {
      headers: { host: branchHost },
    } as never)
    const reply = new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)))
      socket.addEventListener("error", () => reject(new Error("socket failed")))
    })
    socket.addEventListener("open", () => socket.send("hello"))

    expect(await reply).toBe("branch: hello")
    socket.close()
  })

  // A branch's sockets authenticate as its pages do, by their session cookie, and its API checks
  // their origin. Guard check: open the upstream socket without `socket.handshake`
  // (`routes/branch-preview.ts`): the branch sees no cookie, and answers 401.
  test("passes a page's cookie, origin and subprotocol on to the branch, never the key", async () => {
    const seen: Record<string, string | null>[] = []
    const { origin, branchHost } = await previewLab(
      (request, server) => {
        seen.push({
          cookie: request.headers.get("cookie"),
          origin: request.headers.get("origin"),
          key: request.headers.get(BRANCH_KEY_HEADER),
          protocol: request.headers.get("sec-websocket-protocol"),
        })
        return server.upgrade(request, {
          headers: { "sec-websocket-protocol": "sixb.v1" },
          data: undefined,
        })
          ? undefined
          : new Response("no", { status: 400 })
      },
      {},
      {
        open: (ws) => {
          ws.send("open")
        },
        message: () => undefined,
      }
    )

    const socket = new WebSocket(`${origin.replace("http", "ws")}/ws/events`, {
      headers: {
        host: branchHost,
        cookie: "sixb_session_app=ada",
        origin: `https://${branchHost}`,
        [BRANCH_KEY_HEADER]: KEY,
      },
      protocols: ["sixb.v1"],
    } as never)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", () => resolve())
      socket.addEventListener("error", () => reject(new Error("socket failed")))
    })
    socket.close()

    expect(seen).toEqual([
      {
        cookie: "sixb_session_app=ada",
        origin: `https://${branchHost}`,
        key: null,
        protocol: "sixb.v1",
      },
    ])
  })
})

describe("a preview domain", () => {
  // A branch's pages on production's site would get its SameSite cookies, and could set its CSRF
  // cookie. Guard check: return early from `assertPreviewSiteApart` (`branches/preview.ts`).
  test("is refused on production's site: its cookies' domain, its API's or its app's", () => {
    const storage = new InMemoryStorage()
    const withPreview = (previewDomain: string, auth?: SixbHostOptions["auth"]) =>
      new SixbHost(
        options(storage, {
          source: { repository: "acme/shop", previewDomain },
          ...(auth ? { auth } : {}),
        })
      )

    expect(() =>
      withPreview("preview.shop.test", {
        strategy: { id: "test", kind: "dev" },
        cookies: { cookieDomain: "app.shop.test" },
      })
    ).toThrow("same site as production's cookieDomain")

    const production = withPreview("preview.shop.test")
    expect(
      () =>
        new SixbServer({
          host: production,
          quiet: true,
          browser: createTestBrowserPolicy({
            apiOrigin: "https://api.elsewhere.test",
            appOrigin: "https://app.shop.test",
          }),
        })
    ).toThrow("same site as production's app ('app.shop.test')")

    const apart = withPreview("shop-preview.test")
    expect(
      () =>
        new SixbServer({
          host: apart,
          quiet: true,
          browser: createTestBrowserPolicy({
            apiOrigin: "https://api.shop.test",
            appOrigin: "https://app.shop.test",
          }),
        })
    ).not.toThrow()
  })

  // Each subdomain of a suffix on the Public Suffix List is a site of its own.
  test("names the site of a host as browsers do", () => {
    expect(siteOf("app.shop.dev")).toBe("shop.dev")
    expect(siteOf("feature-x.shop-preview.dev")).toBe("shop-preview.dev")
    expect(siteOf("feature-x.vercel.app")).toBe("feature-x.vercel.app")
    expect(siteOf("app.shop.co.uk")).toBe("shop.co.uk")
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
