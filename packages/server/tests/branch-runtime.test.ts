import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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
  resolveAuthorizationContext,
  SixbHost,
  type SixbHostOptions,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import {
  BRANCH_CREDENTIAL_PREFIX,
  type BranchRuntime,
  hostOnBranch,
} from "@sixb/core/internal/branches"
import { putOnBranch } from "@sixb/core/internal/runtime"
import { exportSnapshot, hostSnapshotSource, importSnapshot } from "@sixb/core/internal/snapshots"
import { createTestSixb } from "@sixb/core/testing"
import { createTestingScope } from "../../core/src/execution/scopes"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy, getFreePort } from "./helpers"

// A branch on a laptop serves every request as the person who copied production's data, and reads
// the files of its objects through production, as that person.

const PROJECT = "branch-runtime"
const Ticket = defineObjectType({
  id: "ticket",
  name: "Ticket",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("status", "string", { query: { searchable: true, filterable: true } }),
    prop("attachment", "fileRef"),
  ],
})
const developers = defineGroup("developers")
const readers = defineGroup("readers")
const roles = [
  defineRole("developers", {
    grantedTo: [developers],
    grants: [
      can.manage(project.source),
      can.view(Ticket).where((ticket) => ticket.p.status.eq("open")),
    ],
  }),
  defineRole("readers", { grantedTo: [readers], grants: [can.view(Ticket)] }),
]

function options(storage: InMemoryStorage, blobStorage = new InMemoryBlobStorage()) {
  return {
    id: PROJECT,
    ontology: [Ticket],
    groups: [developers, readers],
    roles,
    storage,
    blobStorage,
    lakeStorage: new InMemoryLakeStorage(),
    broker: new InMemoryBroker(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" },
  } satisfies SixbHostOptions
}

let production: { host: SixbHost; storage: InMemoryStorage; url: string }
let server: ReturnType<typeof Bun.serve>
let branch: {
  app: ReturnType<typeof createSixbApi>
  host: SixbHost
  storage: InMemoryStorage
}
const tokens: Record<string, string> = {}
let credential: string

beforeAll(async () => {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost(options(storage, blobStorage))
  const trusted = createTestSixb(host)
  for (const [id, status] of [
    ["t-1", "open"],
    ["t-2", "closed"],
  ] as const) {
    const attachment = await blobStorage.put({
      body: new TextEncoder().encode(`${id} file`),
      fileName: `${id}.txt`,
      mediaType: "text/plain",
    })
    await trusted.objects(Ticket).upsert({ properties: { id, status, attachment } })
  }
  for (const [userId, groupId] of [
    ["usr_alice", developers.id],
    ["usr_bob", readers.id],
  ] as const) {
    await storage.auth.users.create({ projectId: PROJECT, id: userId, email: `${userId}@x.test` })
    await storage.auth.groupMemberships.upsert({
      projectId: PROJECT,
      userId,
      groupId,
      source: "manual",
    })
    const { session, tokens: issued } = host.auth.prepareBearerSession({
      userId,
      clientName: "sixb CLI",
      now: new Date(),
    })
    await storage.auth.sessions.create(session)
    tokens[userId] = `Bearer ${issued.accessToken}`
  }
  const app = createSixbApi(
    new SixbServer({ host, quiet: true, browser: createTestBrowserPolicy() })
  )
  server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) })
  production = { host, storage, url: server.url.toString() }

  // Alice's copy, on a branch that holds its objects but not their files.
  const laptop = new InMemoryStorage()
  const base = new SixbHost(
    putOnBranch(options(laptop), { name: "feature/x", dataFrom: "production" })
  )
  const namespace = (await laptop.createBranchNamespace("feature-x")) as InMemoryStorage
  const scope = createTestingScope({
    projectId: PROJECT,
    context: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_alice" },
      groupIds: [developers.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  const report = await importSnapshot({
    snapshot: exportSnapshot(hostSnapshotSource(host), { scope }),
    storage: namespace,
    ontology: base.definitions.ontology as never,
  })
  // The branch's credential, as a copy records it with its slice: the branch holds no other.
  credential = `${BRANCH_CREDENTIAL_PREFIX}${"k".repeat(43)}`
  await storage.lakeSlices.create({
    id: "slice_alice",
    projectId: PROJECT,
    userId: "usr_alice",
    branch: "feature/x",
    point: "point",
    versions: [],
    files: [],
    createdAt: new Date(),
    credentialHash: createHash("sha256").update(credential).digest("hex"),
  })
  const runtime: BranchRuntime = {
    person: { userId: "usr_alice" },
    production: { url: production.url, authorization: async () => `Bearer ${credential}` },
    takenAt: report.takenAt,
  }
  const branchHost = hostOnBranch(base, { storage: namespace, runtime })
  // A ticket the branch made, closed: Alice's conditions hide it from her too.
  await createTestSixb(branchHost)
    .objects(Ticket)
    .upsert({ properties: { id: "t-3", status: "closed" } })
  branch = {
    app: createSixbApi(
      new SixbServer({ host: branchHost, quiet: true, browser: createTestBrowserPolicy() })
    ),
    host: branchHost,
    storage: namespace,
  }
})

afterAll(() => server?.stop(true))

const get = (path: string, headers: Record<string, string> = {}) =>
  branch.app.fetch(new Request(`http://api.localhost${path}`, { headers }))

const ticketIds = async (headers: Record<string, string> = {}) => {
  const response = await get("/api/objects?objectTypeId=ticket", headers)
  const body = (await response.json()) as { objects: { properties: { id: string } }[] }
  return body.objects.map((object) => object.properties.id).sort()
}

describe("a branch from production", () => {
  // Red check: in server.ts, drop the branch person's binding: a request without credentials runs
  // with auth off and reads t-3, and Bob's token is taken for Bob.
  test("runs every request as the person who copied it, whoever sends it", async () => {
    expect(await ticketIds()).toEqual(["t-1"])
    // Bob's production token means nothing here: the request still runs as Alice.
    expect(await ticketIds({ authorization: tokens.usr_bob! })).toEqual(["t-1"])

    // Nor does a session someone made on the branch's own storage.
    const credential = createSessionCredential("ses_branch_bob")
    await branch.storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: PROJECT,
      userId: "usr_bob",
      strategyId: "test",
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    expect(await ticketIds({ cookie: `sixb_session_app=${credential.cookieValue}` })).toEqual([
      "t-1",
    ])

    // The app asks no one to sign in.
    const session = (await (await get("/api/auth/session")).json()) as { authEnabled: boolean }
    expect(session.authEnabled).toBe(false)
  })

  // Red check: in routes/objects.ts, drop the read through production: t-1's file is not on the
  // branch, and its content answers 404.
  test("reads its objects' files through production, as that person", async () => {
    const path = encodeURIComponent("/properties/attachment")
    const own = await get(`/api/objects/ticket/t-1/files/content?path=${path}`)
    expect(own.status).toBe(200)
    expect(await own.text()).toBe("t-1 file")

    // t-2 is closed: production refuses Alice its file, though Bob may read it there.
    const hidden = await get(`/api/objects/ticket/t-2/files/content?path=${path}`)
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).not.toContain("t-2 file")
    const asBob = await fetch(
      new URL(`api/objects/ticket/t-2/files/content?path=${path}`, production.url),
      { headers: { authorization: tokens.usr_bob! } }
    )
    expect(await asBob.text()).toBe("t-2 file")
  })
})

describe("a branch's credential in production", () => {
  // Red check: in server.ts, drop `isBranchCredentialRoute` from the credential's binding: it
  // reads every object Alice reads, and writes where she may.
  test("reads its objects' files as its person, and nothing else", async () => {
    const asBranch = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, production.url), {
        ...init,
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      })

    const path = encodeURIComponent("/properties/attachment")
    expect((await asBranch(`api/objects/ticket/t-1/files/content?path=${path}`)).status).toBe(200)
    expect((await asBranch("api/objects?objectTypeId=ticket")).status).toBe(403)
    expect(
      (await asBranch("api/objects/query", { method: "POST", body: JSON.stringify({}) })).status
    ).toBe(403)
    expect(
      (
        await asBranch("api/branches/copy", {
          method: "POST",
          body: JSON.stringify({ branch: "feature/y" }),
        })
      ).status
    ).toBe(403)
  })

  // Red check: in branches/credential.ts, drop the `source.manage` check: Bob reads t-1's file.
  test("reads nothing once its person may no longer copy to a branch", async () => {
    // A slice Bob took when he still could: he reads every ticket, but no longer manages the source.
    const bobs = `${BRANCH_CREDENTIAL_PREFIX}${"b".repeat(43)}`
    await production.storage.lakeSlices.create({
      id: "slice_bob",
      projectId: PROJECT,
      userId: "usr_bob",
      branch: "feature/y",
      point: "point",
      versions: [],
      files: [],
      createdAt: new Date(),
      credentialHash: createHash("sha256").update(bobs).digest("hex"),
    })

    const path = encodeURIComponent("/properties/attachment")
    const response = await fetch(
      new URL(`api/objects/ticket/t-1/files/content?path=${path}`, production.url),
      { headers: { authorization: `Bearer ${bobs}` } }
    )
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("t-1 file")
  })

  // Red check: in server.ts, drop the loopback check of the branch person's binding.
  test("answers only requests that name this machine", async () => {
    const response = await branch.app.fetch(
      new Request("http://127.0.0.1/api/objects?objectTypeId=ticket", {
        headers: { host: "rebound.example.com" },
      })
    )
    expect(response.status).toBe(403)
  })
})

describe("a branch and the websites a browser opens", () => {
  // A branch runs every request as Alice, so the browser origin check is all that keeps a page
  // elsewhere from acting as her: `sixb dev` lets only this machine's origins through on a branch.
  // Red check: in server.ts, drop `rejectDisallowedBrowserOrigin` from `onRequest`: a page on any
  // website runs a schedule as Alice, and opens her sockets.
  test("refuses a request a page elsewhere sends, and takes one this machine's pages send", async () => {
    const post = (origin: string) =>
      branch.app.fetch(
        new Request("http://localhost/api/schedules/nightly/runs", {
          method: "POST",
          headers: { origin, "content-type": "text/plain" },
        })
      )
    expect((await post("https://evil.example")).status).toBe(403)
    expect((await post("null")).status).toBe(403)
    // Past the origin, the request reaches the route: this project has no such schedule.
    expect((await post("http://app.localhost")).status).toBe(404)
  })

  test("opens its sockets to this machine's pages only", async () => {
    const port = await getFreePort()
    const server = new SixbServer({
      host: branch.host,
      hostname: "127.0.0.1",
      port,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: `http://127.0.0.1:${port}` }),
    })
    await server.start()
    try {
      for (const path of ["/ws/events", "/ws/agents", "/ws/logs"]) {
        const url = `ws://127.0.0.1:${port}${path}`
        expect(await opens(url, "https://evil.example")).toBe(false)
        expect(await opens(url, "http://app.localhost")).toBe(true)
      }
    } finally {
      await server.stop()
    }
  })
})

/** Whether a socket to `url` opens for a page of `origin`: it opens, or it closes unopened. */
function opens(url: string, origin: string): Promise<boolean> {
  const TestWebSocket = WebSocket as unknown as new (
    url: string,
    options: { readonly headers: Record<string, string> }
  ) => WebSocket
  const ws = new TestWebSocket(url, { headers: { origin } })

  return new Promise((resolve) => {
    ws.addEventListener("open", () => {
      ws.close()
      resolve(true)
    })
    ws.addEventListener("close", () => resolve(false))
  })
}
