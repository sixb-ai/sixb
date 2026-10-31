import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { realpathSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { runSandboxCredentialsContractSuite } from "@sixb/core/testing"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

runSandboxCredentialsContractSuite("LocalSandbox credentials (none)", {
  createFactory: () => new LocalSandboxFactory({ isolation: "none" }),
  separatesSandboxes: false,
})

const backend = detectIsolation().backend
if (backend !== "none") {
  runSandboxCredentialsContractSuite(`LocalSandbox credentials (${backend})`, {
    createFactory: () => new LocalSandboxFactory({ isolation: backend }),
  })
}

// Guard proof: drop the forwarding headers' removal in CredentialForwarder.forward; the API sees
// the address the command chose.
describe("LocalSandbox credential forwarding", () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        Response.json({
          forwardedFor: request.headers.get("x-forwarded-for"),
          forwarded: request.headers.get("forwarded"),
        }),
    })
  })
  afterAll(() => server.stop(true))

  test("a command can't say whom its request is from", async () => {
    const origin = `http://127.0.0.1:${server.port}`
    const sandbox = await new LocalSandboxFactory({ isolation: "none" }).create({
      requestCredentials: [
        {
          origin,
          path: { prefix: "/api/" },
          method: "GET",
          headers: { Authorization: "Bearer t" },
        },
      ],
    })
    try {
      const address = sandbox.credentialedUrl?.(origin) ?? ""
      const result = await sandbox.runCommand("curl", [
        "-sS",
        "-H",
        "X-Forwarded-For: 203.0.113.9",
        "-H",
        "Forwarded: for=203.0.113.9",
        "--unix-socket",
        address.slice("unix:".length),
        "http://localhost/api/whoami",
      ])
      expect(JSON.parse(result.stdout)).toEqual({ forwardedFor: null, forwarded: null })
    } finally {
      await sandbox.destroy()
    }
  })
})

describe.skipIf(backend === "none")(`LocalSandbox forwarders (${backend})`, () => {
  let server: ReturnType<typeof Bun.serve>
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new Response(request.headers.get("authorization")),
    })
  })
  afterAll(() => server.stop(true))

  // Guard proof: drop the forwarder root's file-write deny from buildSeatbeltProfile; B moves A's
  // directory out of the root and gets A's credential.
  test("a command can't reach another sandbox's forwarder by moving it", async () => {
    const origin = `http://127.0.0.1:${server.port}`
    const secret = `local-${randomUUID()}`
    const factory = new LocalSandboxFactory({ isolation: backend })
    const a = await factory.create({
      requestCredentials: [
        {
          origin,
          path: { prefix: "/api/" },
          method: "GET",
          headers: { Authorization: `Bearer ${secret}` },
        },
      ],
    })
    const b = await factory.create({ network: { mode: "all" } })
    const moved = join(realpathSync("/tmp"), `sixb-moved-${randomUUID().slice(0, 8)}`)
    try {
      const socket = (a.credentialedUrl?.(origin) ?? "").slice("unix:".length)
      const result = await b.runCommand("sh", [
        "-c",
        'mv "$1" "$2"; curl -sS -m 5 --unix-socket "$2/$3" http://localhost/api/whoami',
        "sh",
        dirname(socket),
        moved,
        socket.slice(dirname(socket).length + 1),
      ])
      expect(result.stdout).not.toContain(secret)
    } finally {
      await a.destroy()
      await b.destroy()
      rmSync(moved, { recursive: true, force: true })
    }
  })
})
