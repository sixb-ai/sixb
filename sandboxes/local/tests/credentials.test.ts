import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { runSandboxCredentialsContractSuite } from "@sixb/core/testing"
import { detectIsolation } from "../src/isolation/detect"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

runSandboxCredentialsContractSuite("LocalSandbox credentials (none)", {
  createFactory: () => new LocalSandboxFactory({ isolation: "none" }),
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
