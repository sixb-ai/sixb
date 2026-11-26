import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { updateConfig } from "../src/profiles"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "main.ts")
const servers: Bun.Server<undefined>[] = []
const cleanups: (() => Promise<void>)[] = []

afterAll(async () => {
  while (servers.length > 0) {
    servers.pop()?.stop(true)
  }
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function signedInProfile(apiUrl: string, accessToken: string) {
  const root = await mkdtemp(resolve(tmpdir(), "sixb-cli-signed-in-"))
  await updateConfig(
    () => ({
      version: 1,
      currentProfile: "acme",
      profiles: {
        acme: {
          apiUrl,
          projectId: "acme",
          session: {
            accessToken,
            refreshToken: "sixb_rt_ses_cli.secret",
            accessExpiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      },
    }),
    { env: { XDG_CONFIG_HOME: root } }
  )
  return {
    env: {
      XDG_CONFIG_HOME: root,
      SIXB_API_URL: undefined,
      SIXB_API_BASE_URL: undefined,
      SIXB_API_PUBLIC_ORIGIN: undefined,
      SIXB_API_TOKEN: undefined,
      SIXB_TOKEN: undefined,
      SIXB_PROFILE: undefined,
      SIXB_RUN_ID: undefined,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) merged[k] = v
  }
  const child = Bun.spawn(["bun", cliEntry, ...args], {
    cwd: repoRoot,
    env: merged,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

describe("sixb service-accounts command", () => {
  test.concurrent("creates service accounts with SIXB_API_URL and SIXB_API_TOKEN", async () => {
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

    const result = await runCli(
      [
        "service-accounts",
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
      {
        SIXB_API_URL: `http://127.0.0.1:${server.port}/api`,
        SIXB_API_BASE_URL: undefined,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
        SIXB_RUN_ID: undefined,
      }
    )
    expect(result.exitCode, result.stderr).toBe(0)

    expect(requestedPath).toBe("/api/auth/service-accounts")
    expect(authorizationHeader).toBe("Bearer sixb_pat_tok_cli.secret")
    expect(requestBody).toEqual({
      id: "svc_agents",
      name: "Agents",
      description: "Sandbox agents",
      groupIds: ["agents"],
    })
    expect(JSON.parse(result.stdout).serviceAccount.id).toBe("svc_agents")
    expect(result.stderr).toBe("")
  }, 15_000)

  test.concurrent("creates service-account tokens under one service account", async () => {
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

    const result = await runCli(
      [
        "service-accounts",
        "tokens",
        "create",
        "svc_agents",
        "--name",
        "Sandbox token",
        "--expires-at",
        "2099-01-01T00:00:00.000Z",
        "--group",
        "agents",
      ],
      profile.env
    )
    expect(result.exitCode, result.stderr).toBe(0)

    expect(requestedPath).toBe("/api/auth/service-accounts/svc_agents/access-tokens")
    expect(authorizationHeader).toBe("Bearer sixb_at_ses_cli.secret")
    expect(requestBody).toEqual({
      name: "Sandbox token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      groupIds: ["agents"],
    })
    expect(JSON.parse(result.stdout).tokenValue).toBe("sixb_sat_tok_cli.secret")
    expect(result.stderr).toBe("")
  }, 15_000)

  test.concurrent("refuses to create a service-account token with an access token", async () => {
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

    const result = await runCli(
      ["service-accounts", "tokens", "create", "svc_agents", "CI", "--json"],
      {
        SIXB_API_URL: `http://127.0.0.1:${server.port}`,
        SIXB_API_BASE_URL: undefined,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
        SIXB_RUN_ID: undefined,
      }
    )

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stderr).error.message).toContain(
      "an access token cannot create another token"
    )
    expect(requests).toBe(0)
  }, 15_000)
})
