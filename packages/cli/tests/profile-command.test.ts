import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "main.ts")
const servers: Bun.Server<undefined>[] = []
const tempDirectories: string[] = []

afterAll(async () => {
  while (servers.length > 0) servers.pop()?.stop(true)
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  stdin?: string
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) merged[k] = v
  }
  const child = Bun.spawn(["bun", cliEntry, ...args], {
    cwd: repoRoot,
    env: merged,
    stdin: stdin === undefined ? "ignore" : new Response(stdin),
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

async function tempConfigEnvironment(): Promise<Record<string, string | undefined>> {
  const configRoot = await mkdtemp(join(tmpdir(), "sixb-cli-profile-"))
  tempDirectories.push(configRoot)
  return {
    XDG_CONFIG_HOME: configRoot,
    SIXB_API_URL: undefined,
    SIXB_API_BASE_URL: undefined,
    SIXB_API_PUBLIC_ORIGIN: undefined,
    SIXB_API_TOKEN: undefined,
    SIXB_TOKEN: undefined,
    SIXB_PROFILE: undefined,
    SIXB_RUN_ID: undefined,
  }
}

function startProjectServer(
  options: { readonly token?: string; readonly projectId?: string } = {}
) {
  const authorizationHeaders: Array<string | null> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      authorizationHeaders.push(authorization)
      if (options.token && authorization !== `Bearer ${options.token}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 })
      }
      if (url.pathname === "/api/auth/access-tokens") {
        return Response.json({ accessTokens: [] })
      }
      return Response.json({ id: options.projectId ?? "acme-production" })
    },
  })
  servers.push(server)
  return { server, authorizationHeaders }
}

describe("sixb profile commands", () => {
  test.concurrent("signs in through the browser, renews the session, and signs out", async () => {
    const env: Record<string, string | undefined> = {
      ...(await tempConfigEnvironment()),
      SIXB_CLI_NO_BROWSER: "1",
    }
    const calls: string[] = []
    let currentAccessToken = "access-1"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        calls.push(
          `${request.method} ${url.pathname} ${request.headers.get("authorization") ?? ""}`
        )
        if (url.pathname === "/api/auth/device-authorizations") {
          expect(await request.json()).toMatchObject({
            clientName: expect.stringMatching(/^sixb CLI on /),
          })
          return Response.json(
            {
              deviceCode: "dva_test.device-secret",
              userCode: "BCDF-HJKM",
              verificationUri: `${url.origin}/auth/device`,
              verificationUriComplete: `${url.origin}/auth/device?user_code=BCDF-HJKM`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              interval: 1,
            },
            { status: 201 }
          )
        }
        if (url.pathname === "/api/auth/device-authorizations/token") {
          return Response.json({
            status: "approved",
            accessToken: "access-1",
            refreshToken: "refresh-1",
            expiresIn: 30,
          })
        }
        if (url.pathname === "/api/auth/refresh") {
          expect(await request.json()).toEqual({ refreshToken: "refresh-1" })
          currentAccessToken = "access-2"
          return Response.json({
            accessToken: "access-2",
            refreshToken: "refresh-2",
            expiresIn: 900,
          })
        }
        if (request.headers.get("authorization") !== `Bearer ${currentAccessToken}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 })
        }
        if (url.pathname === "/api/auth/sign-out") return Response.json({ success: true })
        return Response.json({ id: "browser-project" })
      },
    })
    servers.push(server)
    const apiUrl = `http://127.0.0.1:${server.port}`
    const configPath = join(env.XDG_CONFIG_HOME!, "sixb", "config.json")

    const login = await runCli(["login", apiUrl, "--profile", "codex", "--json"], env)
    expect(login.exitCode, login.stderr).toBe(0)
    expect(login.stderr).toContain(`Opening ${apiUrl}/auth/device?user_code=BCDF-HJKM`)
    expect(login.stderr).toContain("Confirm code: BCDF-HJKM")
    expect(JSON.parse(login.stdout)).toEqual({
      profile: "codex",
      projectId: "browser-project",
      apiUrl,
      authenticated: true,
    })
    expect(JSON.parse(await readFile(configPath, "utf8")).profiles.codex.session).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
    })

    const project = await runCli(["project", "show"], env)
    expect(project.exitCode, project.stderr).toBe(0)
    expect(JSON.parse(project.stdout)).toEqual({ id: "browser-project" })
    expect(calls.slice(-2)).toEqual(["POST /api/auth/refresh ", "GET /api/project Bearer access-2"])
    expect(JSON.parse(await readFile(configPath, "utf8")).profiles.codex.session).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    })

    const logout = await runCli(["logout", "--profile", "codex", "--json"], env)
    expect(logout.exitCode, logout.stderr).toBe(0)
    expect(calls.at(-1)).toBe("POST /api/auth/sign-out Bearer access-2")
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ version: 1, profiles: {} })
  }, 20_000)

  test.concurrent("imports a token, stores a profile, and dispatches API commands", async () => {
    const env = await tempConfigEnvironment()
    const { server, authorizationHeaders } = startProjectServer({ token: "secret-token" })
    const apiUrl = `http://127.0.0.1:${server.port}`

    const login = await runCli(
      ["login", apiUrl, "--profile", "codex", "--token-stdin", "--json"],
      env,
      "secret-token\n"
    )
    expect(login.exitCode, login.stderr).toBe(0)
    expect(login.stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(login.stdout)).toEqual({
      profile: "codex",
      projectId: "acme-production",
      apiUrl,
      authenticated: true,
    })
    expect(authorizationHeaders).toEqual([null, "Bearer secret-token"])

    const project = await runCli(["project", "show"], env)
    expect(project.exitCode, project.stderr).toBe(0)
    expect(JSON.parse(project.stdout)).toEqual({ id: "acme-production" })
    expect(authorizationHeaders.at(-1)).toBe("Bearer secret-token")

    const tokens = await runCli(["tokens", "list", "--json"], env)
    expect(tokens.exitCode, tokens.stderr).toBe(0)
    expect(JSON.parse(tokens.stdout)).toEqual({ accessTokens: [] })
    expect(authorizationHeaders.at(-1)).toBe("Bearer secret-token")

    const status = await runCli(["status", "--json"], env)
    expect(status.exitCode, status.stderr).toBe(0)
    expect(status.stdout).not.toContain("secret-token")
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      connected: true,
      authenticated: true,
      profile: "codex",
      project: { id: "acme-production" },
    })

    const list = await runCli(["profile", "list", "--json"], env)
    expect(list.exitCode, list.stderr).toBe(0)
    expect(list.stdout).not.toContain("secret-token")
    expect(JSON.parse(list.stdout)).toMatchObject({
      currentProfile: "codex",
      profiles: [{ name: "codex", current: true, authenticated: true }],
    })

    const show = await runCli(["profile", "show", "codex", "--json"], env)
    expect(show.exitCode, show.stderr).toBe(0)
    expect(show.stdout).not.toContain("secret-token")
    expect(JSON.parse(show.stdout)).toMatchObject({
      name: "codex",
      projectId: "acme-production",
      authenticated: true,
    })

    const use = await runCli(["profile", "use", "codex", "--json"], env)
    expect(use.exitCode, use.stderr).toBe(0)
    expect(JSON.parse(use.stdout)).toMatchObject({ currentProfile: "codex" })

    const logout = await runCli(["logout", "--profile", "codex", "--json"], env)
    expect(logout.exitCode, logout.stderr).toBe(0)
    expect(JSON.parse(logout.stdout)).toEqual({ removed: "codex" })
    const loggedOutConfig = await readFile(
      join(env.XDG_CONFIG_HOME!, "sixb", "config.json"),
      "utf8"
    )
    expect(loggedOutConfig).not.toContain("secret-token")
    expect(JSON.parse(loggedOutConfig)).toEqual({ version: 1, profiles: {} })
  }, 20_000)

  test.concurrent("stores tokenless profiles for auth-disabled instances", async () => {
    const env = await tempConfigEnvironment()
    const { server, authorizationHeaders } = startProjectServer({ projectId: "local-dev" })
    const apiUrl = `http://127.0.0.1:${server.port}`

    const login = await runCli(["login", apiUrl, "--profile", "local", "--json"], env)
    expect(login.exitCode, login.stderr).toBe(0)
    expect(JSON.parse(login.stdout)).toMatchObject({
      profile: "local",
      authenticated: false,
    })
    expect(authorizationHeaders).toEqual([null])

    const status = await runCli(["status", "--json"], env)
    expect(status.exitCode, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      connected: true,
      profile: "local",
      project: { id: "local-dev" },
    })
  }, 20_000)

  test.concurrent("reports an API auth error cleanly when a saved token is rejected", async () => {
    const env = await tempConfigEnvironment()
    let requiredToken = "initial-token"
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${requiredToken}`) {
          return Response.json({ error: "Unauthorized" }, { status: 401 })
        }
        return Response.json({ id: "secured-project" })
      },
    })
    servers.push(server)
    const apiUrl = `http://127.0.0.1:${server.port}`

    const login = await runCli(
      ["login", apiUrl, "--profile", "secured", "--token-stdin", "--json"],
      env,
      `${requiredToken}\n`
    )
    expect(login.exitCode, login.stderr).toBe(0)

    requiredToken = "rotated-token"
    const status = await runCli(["status", "--json"], env)
    expect(status.exitCode).toBe(3)
    expect(JSON.parse(status.stderr).error).toMatchObject({ status: 401 })
  }, 20_000)
})
