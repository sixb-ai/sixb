import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import type { Sandbox, SandboxFactory, SandboxRequestCredential } from "../sandboxes"

export interface SandboxCredentialsContractSuiteOptions {
  /** A factory that advertises `supportsRequestCredentials`. */
  readonly createFactory: () => SandboxFactory | Promise<SandboxFactory>
  /**
   * The origin guest commands reach the suite's server at, given the port it listens on. Defaults
   * to its loopback address, which only a provider running commands on this host can reach.
   */
  readonly originFor?: (port: number) => string
}

/**
 * Provider-independent contract for request credentials: a command reaches the credential's
 * origin with the credential added outside the guest, and nothing the command can read holds it.
 * The suite listens on this host, so the provider's commands must be able to reach it.
 */
export function runSandboxCredentialsContractSuite(
  label: string,
  options: SandboxCredentialsContractSuiteOptions
): void {
  describe(label, () => {
    let server: ReturnType<typeof Bun.serve>
    let origin: string
    let factory: SandboxFactory

    beforeAll(async () => {
      // Echoes what reached it, so a test can tell the credential was added on the way.
      server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: (request) =>
          Response.json({
            method: request.method,
            path: new URL(request.url).pathname,
            authorization: request.headers.get("authorization"),
          }),
      })
      origin = options.originFor?.(server.port ?? 0) ?? `http://127.0.0.1:${server.port}`
      factory = await options.createFactory()
      expect(factory.supportsRequestCredentials).toBe(true)
    })

    afterAll(() => {
      server.stop(true)
    })

    const credential = (secret: string): SandboxRequestCredential => ({
      origin,
      path: { prefix: "/api/" },
      method: ["GET", "POST"],
      headers: { Authorization: `Bearer ${secret}` },
    })

    async function withSandbox(
      credentials: readonly SandboxRequestCredential[],
      use: (sandbox: Sandbox) => Promise<void>
    ): Promise<void> {
      const sandbox = await factory.create({
        network: { mode: "restricted", allow: [{ name: "credentials-suite", origin }] },
        requestCredentials: credentials,
      })
      try {
        await use(sandbox)
      } finally {
        await sandbox.destroy()
      }
    }

    test("a command reaches the origin with the credential added", async () => {
      const secret = `suite-${randomUUID()}`
      await withSandbox([credential(secret)], async (sandbox) => {
        const seen = await request(sandbox, origin, "/api/whoami")
        expect(seen).toEqual({
          method: "GET",
          path: "/api/whoami",
          authorization: `Bearer ${secret}`,
        })
      })
    })

    test("only a request the credential matches gets it, replacing the command's own", async () => {
      const secret = `suite-${randomUUID()}`
      await withSandbox([credential(secret)], async (sandbox) => {
        expect((await request(sandbox, origin, "/health")).authorization).toBeNull()
        expect(
          (await request(sandbox, origin, "/api/x", ["-X", "DELETE"])).authorization
        ).toBeNull()
        const forged = await request(sandbox, origin, "/api/x", [
          "-H",
          "Authorization: Bearer guest",
        ])
        expect(forged.authorization).toBe(`Bearer ${secret}`)
      })
    })

    test("setRequestCredentials replaces the credentials, and an empty list removes them", async () => {
      const first = `suite-${randomUUID()}`
      const second = `suite-${randomUUID()}`
      await withSandbox([credential(first)], async (sandbox) => {
        if (!sandbox.setRequestCredentials) throw new Error("setRequestCredentials is missing")
        await sandbox.setRequestCredentials([credential(second)])
        expect((await request(sandbox, origin, "/api/x")).authorization).toBe(`Bearer ${second}`)
        await sandbox.setRequestCredentials([])
        expect((await request(sandbox, origin, "/api/x")).authorization).toBeNull()
      })
    })

    test("nothing a command can read holds the credential", async () => {
      const secret = `suite-${randomUUID()}`
      await withSandbox([credential(secret)], async (sandbox) => {
        // The command's env, every process's command line and env it may read, and its files.
        const looked = await sandbox.runCommand("bash", [
          "-c",
          [
            "env",
            "ps -eo args 2>/dev/null",
            "cat /proc/*/environ /proc/*/cmdline 2>/dev/null | tr '\\0' '\\n'",
            "find . -type f -exec cat {} + 2>/dev/null",
          ].join("; "),
        ])
        expect(looked.stdout.length).toBeGreaterThan(0)
        expect(looked.stdout).not.toContain(secret)
        expect(looked.stderr).not.toContain(secret)
      })
    })
  })
}

/** One request from a command, through the sandbox's credentialed address for `origin`. */
async function request(
  sandbox: Sandbox,
  origin: string,
  path: string,
  curlArgs: readonly string[] = []
): Promise<{
  readonly method: string
  readonly path: string
  readonly authorization: string | null
}> {
  if (!sandbox.credentialedUrl) throw new Error("credentialedUrl is missing")
  const address = sandbox.credentialedUrl(origin)
  const target = address.startsWith("unix:")
    ? ["--unix-socket", address.slice("unix:".length), `http://localhost${path}`]
    : [`${address.replace(/\/+$/, "")}${path}`]
  const result = await sandbox.runCommand("curl", ["-sS", "-m", "10", ...curlArgs, ...target])
  if (result.exitCode !== 0) {
    throw new Error(`curl through ${address} failed: ${result.stderr.trim() || result.exitCode}`)
  }
  return JSON.parse(result.stdout)
}
