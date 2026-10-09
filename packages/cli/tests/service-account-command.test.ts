import { afterEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { assertCliSucceeded, runCliToCompletion } from "./shared/cli-process"
import { signedInProfile } from "./shared/signed-in-profile"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const servers: Bun.Server<undefined>[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  while (servers.length > 0) {
    servers.pop()?.stop(true)
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe("sixb service-account command", () => {
  test("creates service accounts with SIXB_API_URL and SIXB_API_TOKEN", async () => {
    let authorizationHeader = null as string | null
    let requestedPath = ""
    let requestBody: unknown
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requestedPath = url.pathname
        authorizationHeader = request.headers.get("authorization")
        requestBody = await request.json()
        return Response.json(
          {
            serviceAccount: {
              id: "svc_agents",
              name: "Agents",
              description: "Sandbox agents",
              status: "active",
              groupIds: ["agents"],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
            },
          },
          { status: 201 }
        )
      },
    })
    servers.push(server)

    const result = await runCliToCompletion({
      cmd: [
        "bun",
        cliEntry,
        "service-account",
        "create",
        "--id",
        "svc_agents",
        "--name",
        "Agents",
        "--description",
        "Sandbox agents",
        "--group",
        "agents",
      ],
      cwd: repoRoot,
      env: {
        SIXB_API_URL: `http://127.0.0.1:${server.port}/api`,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      },
    })
    assertCliSucceeded(result)

    expect(requestedPath).toBe("/api/auth/service-accounts")
    expect(authorizationHeader).toBe("Bearer sixb_pat_tok_cli.secret")
    expect(requestBody).toEqual({
      id: "svc_agents",
      name: "Agents",
      description: "Sandbox agents",
      groupIds: ["agents"],
    })
    expect(result.stdout).toContain("Created service account")
    expect(result.stdout).toContain("svc_agents")
    expect(result.stderr).toBe("")
  }, 15_000)

  test("creates service-account tokens under one service account", async () => {
    let authorizationHeader = null as string | null
    let requestedPath = ""
    let requestBody: unknown
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        requestedPath = url.pathname
        authorizationHeader = request.headers.get("authorization")
        requestBody = await request.json()
        return Response.json(
          {
            accessToken: {
              id: "tok_sandbox",
              name: "Sandbox token",
              kind: "serviceAccount",
              status: "active",
              subject: { type: "serviceAccount", id: "svc_agents" },
              groupIds: ["agents"],
              createdAt: "2026-06-21T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            tokenValue: "sixb_sat_tok_cli.secret",
          },
          { status: 201 }
        )
      },
    })
    servers.push(server)
    const profile = await signedInProfile(
      `http://127.0.0.1:${server.port}`,
      "sixb_at_ses_cli.secret"
    )
    cleanups.push(profile.cleanup)

    const result = await runCliToCompletion({
      cmd: [
        "bun",
        cliEntry,
        "service-account",
        "token",
        "create",
        "svc_agents",
        "--name",
        "Sandbox token",
        "--expires-at",
        "2099-01-01T00:00:00.000Z",
        "--group",
        "agents",
      ],
      cwd: repoRoot,
      env: profile.env,
    })
    assertCliSucceeded(result)

    expect(requestedPath).toBe("/api/auth/service-accounts/svc_agents/access-tokens")
    expect(authorizationHeader).toBe("Bearer sixb_at_ses_cli.secret")
    expect(requestBody).toEqual({
      name: "Sandbox token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      groupIds: ["agents"],
    })
    expect(result.stdout).toContain("Created service-account token")
    expect(result.stdout).toContain("sixb_sat_tok_cli.secret")
    expect(result.stderr).toBe("")
  }, 15_000)

  // Reproduce: drop `assertSignedIn` from createServiceAccountToken; the CLI then sends the
  // request with the access token, and this permissive server mints it.
  test("refuses to create a service-account token with an access token", async () => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1
        return Response.json({}, { status: 201 })
      },
    })
    servers.push(server)

    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "service-account", "token", "create", "svc_agents", "CI", "--json"],
      cwd: repoRoot,
      env: {
        SIXB_API_URL: `http://127.0.0.1:${server.port}`,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      },
    })

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.message).toContain(
      "an access token cannot create another token"
    )
    expect(requests).toBe(0)
  }, 15_000)
})
