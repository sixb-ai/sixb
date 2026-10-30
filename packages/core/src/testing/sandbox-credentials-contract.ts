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
  /**
   * Where the provider keeps credentials on the commands' side of the boundary, such as a guest
   * forwarder's state: the suite tries to read everything under them.
   */
  readonly privatePaths?: readonly string[]
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
          (await request(sandbox, origin, "/api/x", { method: "DELETE" })).authorization
        ).toBeNull()
        const forged = await request(sandbox, origin, "/api/x", { authorization: "Bearer guest" })
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
            ...(options.privatePaths ?? []).map(
              (path) => `find '${path}' -type f -exec cat {} + 2>/dev/null`
            ),
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
  options: { readonly method?: string; readonly authorization?: string } = {}
): Promise<{
  readonly method: string
  readonly path: string
  readonly authorization: string | null
}> {
  if (!sandbox.credentialedUrl) throw new Error("credentialedUrl is missing")
  const address = sandbox.credentialedUrl(origin)
  const result = await sandbox.runCommand("sh", ["-c", REQUEST_SCRIPT], {
    env: {
      SUITE_ADDRESS: address,
      SUITE_PATH: path,
      SUITE_METHOD: options.method ?? "GET",
      SUITE_AUTHORIZATION: options.authorization ?? "",
      SUITE_FETCH: FETCH_PROGRAM,
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `a request through ${address} failed: ${result.stderr.trim() || result.exitCode}`
    )
  }
  return JSON.parse(result.stdout)
}

// curl where the guest has it, else Bun or Node: a guest that runs the agent CLI has one of them.
const REQUEST_SCRIPT = `set -eu
if command -v curl >/dev/null 2>&1; then
  set -- -sS -m 10 -X "$SUITE_METHOD"
  [ -z "$SUITE_AUTHORIZATION" ] || set -- "$@" -H "Authorization: $SUITE_AUTHORIZATION"
  case "$SUITE_ADDRESS" in
    unix:*) exec curl "$@" --unix-socket "\${SUITE_ADDRESS#unix:}" "http://localhost$SUITE_PATH" ;;
    *) exec curl "$@" "\${SUITE_ADDRESS%/}$SUITE_PATH" ;;
  esac
elif command -v bun >/dev/null 2>&1; then
  exec bun -e "$SUITE_FETCH"
else
  exec node --input-type=module -e "$SUITE_FETCH"
fi`

const FETCH_PROGRAM = `const { SUITE_ADDRESS: address, SUITE_PATH: path, SUITE_METHOD: method } = process.env
const headers = process.env.SUITE_AUTHORIZATION ? { authorization: process.env.SUITE_AUTHORIZATION } : {}
if (!address.startsWith("unix:")) {
  console.log(await (await fetch(address.replace(/\\/+$/, "") + path, { method, headers })).text())
} else if (typeof Bun !== "undefined") {
  console.log(await (await fetch("http://localhost" + path, { method, headers, unix: address.slice(5) })).text())
} else {
  const http = await import("node:http")
  console.log(await new Promise((resolve, reject) => {
    const sent = http.request({ socketPath: address.slice(5), path, method, headers: { ...headers, host: "localhost" } }, (response) => {
      let body = ""
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve(body))
    })
    sent.on("error", reject)
    sent.end()
  }))
}`
