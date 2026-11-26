import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  can,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  project,
  SixbHost,
} from "@sixb/core"
import { readBranchCopy } from "@sixb/core/internal/branches"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy, getFreePort } from "./helpers"

// A branch's copy can go quiet for longer than Bun's fixed 10-second idle timeout: the first cut
// of a large lake took 40 s at 100M rows. The copy route lifts the timeout, and only for a copy
// that passed every check, on a socket that closes with it. Both cases wait out Bun's timeout, so
// they run side by side.
//
// Reproduce: in routes/branches.ts, drop the `server.timeout` call, or pass it `request` instead
// of `servedRequestOf(request)`, which does nothing: the granted copy is reset mid-stream. Lift it
// in server.ts's fetch for every copy request instead: the unauthenticated stalled body is never
// cut. Drop `connection: close` from the copy's response: the kept-alive socket stays open, with
// no timeout. Run `bun test ./packages/server/tests/branch-copy-idle.e2e.ts`.
describe("a branch's copy and Bun's idle timeout", () => {
  let server: SixbServer
  let base: string
  const accessTokens: Record<string, string> = {}

  beforeAll(async () => {
    const developers = defineGroup("developers")
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: "branch-copy-idle",
      ontology: [],
      groups: [developers],
      roles: [
        defineRole("developers", {
          grantedTo: [developers],
          grants: [can.manage(project.source)],
        }),
      ],
      auth: { id: "test", kind: "dev" },
      storage,
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })
    // Two people: each copies one at a time, and both cases below copy at once.
    for (const userId of ["usr_alice", "usr_bob"]) {
      await storage.auth.users.create({ projectId: host.id, id: userId, email: `${userId}@x.test` })
      await storage.auth.groupMemberships.upsert({
        projectId: host.id,
        userId,
        groupId: developers.id,
        source: "manual",
      })
      const { session, tokens } = host.auth.prepareBearerSession({
        userId,
        clientName: "sixb CLI",
        now: new Date(),
      })
      await storage.auth.sessions.create(session)
      accessTokens[userId] = tokens.accessToken
    }

    // Production takes 12 s to open its consistent read, sending nothing meanwhile.
    const readSnapshot = storage.readSnapshot.bind(storage)
    storage.readSnapshot = async (...args) => {
      await Bun.sleep(12_000)
      return readSnapshot(...args)
    }

    const port = await getFreePort()
    base = `http://127.0.0.1:${port}`
    server = new SixbServer({
      host,
      port,
      hostname: "127.0.0.1",
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: base, appOrigin: base }),
    })
    await server.start()
  })

  afterAll(async () => {
    await server?.stop()
  })

  test.concurrent("a granted copy that goes quiet past it still arrives whole", async () => {
    const response = await fetch(`${base}/api/branches/copy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessTokens.usr_alice}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ branch: "feature/quiet" }),
      signal: AbortSignal.timeout(30_000),
    })
    expect(response.status).toBe(200)
    // The lifted timeout stays on its socket: the socket serves nothing after the copy.
    expect(response.headers.get("connection")).toBe("close")

    const copy = readBranchCopy(response.body as unknown as AsyncIterable<Uint8Array>)
    let snapshotBytes = 0
    for await (const chunk of copy.snapshot) snapshotBytes += chunk.length

    expect(snapshotBytes).toBeGreaterThan(0)
    // Read to its end record: a copy cut short throws here.
    expect(await copy.rest()).toBeNull()
  }, 40_000)

  test.concurrent("an unauthenticated copy whose body never comes is still cut", async () => {
    // It declares a body and never sends it: the route is never reached.
    const head =
      "POST /api/branches/copy HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n"

    expect(await closedWithin(head, 20_000)).toBe(true)
  }, 30_000)

  test.concurrent("a kept-alive socket closes once its copy is sent", async () => {
    const body = JSON.stringify({ branch: "feature/kept-alive" })
    const request =
      "POST /api/branches/copy HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n" +
      `Authorization: Bearer ${accessTokens.usr_bob}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}`

    expect(await closedWithin(request, 25_000)).toBe(true)
  }, 35_000)

  /** Whether the server closes a socket that sent `bytes` within `ms`. */
  async function closedWithin(bytes: string, ms: number): Promise<boolean> {
    const url = new URL(base)
    const closed = Promise.withResolvers<boolean>()
    const socket = await Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        data() {},
        close: () => closed.resolve(true),
        error: () => closed.resolve(true),
      },
    })
    const timer = setTimeout(() => closed.resolve(false), ms)

    socket.write(bytes)
    const outcome = await closed.promise
    clearTimeout(timer)
    socket.end()

    return outcome
  }
})
