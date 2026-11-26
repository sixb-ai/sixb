import { expect, test } from "bun:test"
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
// of a large lake took 40 s at 100M rows. Reproduce: in server.ts, drop the `server.timeout` call
// for `isBranchCopy` (or pass it the capped request instead of `incoming`, which does nothing) and
// run `bun test ./packages/server/tests/branch-copy-idle.e2e.ts`: the copy is reset mid-stream.
test("a copy that goes quiet past Bun's idle timeout still arrives whole", async () => {
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
  await storage.auth.users.create({ projectId: host.id, id: "usr_alice", email: "a@x.test" })
  await storage.auth.groupMemberships.upsert({
    projectId: host.id,
    userId: "usr_alice",
    groupId: developers.id,
    source: "manual",
  })
  const { session, tokens } = host.auth.prepareBearerSession({
    userId: "usr_alice",
    clientName: "sixb CLI",
    now: new Date(),
  })
  await storage.auth.sessions.create(session)

  // Production takes 12 s to open its consistent read, sending nothing meanwhile.
  const readSnapshot = storage.readSnapshot.bind(storage)
  storage.readSnapshot = async (...args) => {
    await Bun.sleep(12_000)
    return readSnapshot(...args)
  }

  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  const server = new SixbServer({
    host,
    port,
    hostname: "127.0.0.1",
    quiet: true,
    browser: createTestBrowserPolicy({ apiOrigin: base, appOrigin: base }),
  })
  await server.start()

  try {
    const response = await fetch(`${base}/api/branches/copy`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ branch: "feature/quiet" }),
      signal: AbortSignal.timeout(30_000),
    })
    expect(response.status).toBe(200)

    const copy = readBranchCopy(response.body as unknown as AsyncIterable<Uint8Array>)
    let snapshotBytes = 0
    for await (const chunk of copy.snapshot) snapshotBytes += chunk.length

    expect(snapshotBytes).toBeGreaterThan(0)
    // Read to its end record: a copy cut short throws here.
    expect(await copy.rest()).toBeNull()
  } finally {
    await server.stop()
  }
}, 40_000)
