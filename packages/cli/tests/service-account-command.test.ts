import { afterEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const servers: Bun.Server[] = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true)
  }
})

describe("sixb service-account command", () => {
  test("creates service accounts with SIXB_API_URL and SIXB_API_TOKEN", async () => {
    let authorizationHeader: string | null = null
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

    const proc = Bun.spawn({
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
        ...process.env,
        SIXB_API_URL: `http://127.0.0.1:${server.port}/api`,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(requestedPath).toBe("/api/auth/service-accounts")
    expect(authorizationHeader).toBe("Bearer sixb_pat_tok_cli.secret")
    expect(requestBody).toEqual({
      id: "svc_agents",
      name: "Agents",
      description: "Sandbox agents",
      groupIds: ["agents"],
    })
    expect(stdout).toContain("Created service account")
    expect(stdout).toContain("svc_agents")
    expect(stderr).toBe("")
  })

  test("creates service-account tokens under one service account", async () => {
    let authorizationHeader: string | null = null
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
              subjectType: "serviceAccount",
              subjectId: "svc_agents",
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

    const proc = Bun.spawn({
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
      env: {
        ...process.env,
        SIXB_API_URL: `http://127.0.0.1:${server.port}/api`,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(exitCode).toBe(0)
    expect(requestedPath).toBe("/api/auth/service-accounts/svc_agents/access-tokens")
    expect(authorizationHeader).toBe("Bearer sixb_pat_tok_cli.secret")
    expect(requestBody).toEqual({
      name: "Sandbox token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      groupIds: ["agents"],
    })
    expect(stdout).toContain("Created service-account token")
    expect(stdout).toContain("sixb_sat_tok_cli.secret")
    expect(stderr).toBe("")
  })
})
