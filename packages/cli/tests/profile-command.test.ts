import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assertCliSucceeded, runCliToCompletion } from "./shared/cli-process"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const servers: Bun.Server<undefined>[] = []
const tempDirectories: string[] = []

afterEach(async () => {
  while (servers.length > 0) servers.pop()?.stop(true)
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function tempConfigEnvironment(): Promise<Record<string, string | undefined>> {
  const configRoot = await mkdtemp(join(tmpdir(), "sixb-cli-profile-"))
  tempDirectories.push(configRoot)
  return {
    XDG_CONFIG_HOME: configRoot,
    SIXB_API_URL: undefined,
    SIXB_API_PUBLIC_ORIGIN: undefined,
    SIXB_API_TOKEN: undefined,
    SIXB_TOKEN: undefined,
    SIXB_PROFILE: undefined,
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
  test("authorizes login in the browser and stores the exchanged token", async () => {
    const env: Record<string, string | undefined> = {
      ...(await tempConfigEnvironment()),
      SIXB_CLI_NO_BROWSER: "1",
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/auth/device-authorizations") {
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
          return Response.json({ status: "approved", accessToken: "browser-token" })
        }
        if (request.headers.get("authorization") !== "Bearer browser-token") {
          return Response.json({ error: "Unauthorized" }, { status: 401 })
        }
        return Response.json({ id: "browser-project" })
      },
    })
    servers.push(server)
    const apiUrl = `http://127.0.0.1:${server.port}`

    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "login", apiUrl, "--profile", "codex", "--json"],
      cwd: repoRoot,
      env,
    })

    assertCliSucceeded(result)
    expect(result.stderr).toContain(`Opening ${apiUrl}/auth/device?user_code=BCDF-HJKM`)
    expect(result.stderr).toContain("Confirm code: BCDF-HJKM")
    expect(JSON.parse(result.stdout)).toEqual({
      profile: "codex",
      projectId: "browser-project",
      apiUrl,
      authenticated: true,
    })
    expect(await readFile(join(env["XDG_CONFIG_HOME"]!, "sixb", "config.json"), "utf8")).toContain(
      "browser-token"
    )
  }, 20_000)

  test("imports a token, stores a profile, and dispatches instance commands", async () => {
    const env = await tempConfigEnvironment()
    const { server, authorizationHeaders } = startProjectServer({ token: "secret-token" })
    const apiUrl = `http://127.0.0.1:${server.port}`

    const login = await runCliToCompletion({
      cmd: ["bun", cliEntry, "login", apiUrl, "--profile", "codex", "--token-stdin", "--json"],
      cwd: repoRoot,
      env,
      stdin: "secret-token\n",
    })
    assertCliSucceeded(login)
    expect(login.stdout.trim().split("\n")).toHaveLength(1)
    expect(JSON.parse(login.stdout)).toEqual({
      profile: "codex",
      projectId: "acme-production",
      apiUrl,
      authenticated: true,
    })
    expect(authorizationHeaders).toEqual([null, "Bearer secret-token"])

    const project = await runCliToCompletion({
      cmd: ["bun", cliEntry, "project", "show"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(project)
    expect(JSON.parse(project.stdout)).toEqual({ id: "acme-production" })
    expect(authorizationHeaders.at(-1)).toBe("Bearer secret-token")

    const tokens = await runCliToCompletion({
      cmd: ["bun", cliEntry, "token", "list", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(tokens)
    expect(JSON.parse(tokens.stdout)).toEqual({ accessTokens: [] })
    expect(authorizationHeaders.at(-1)).toBe("Bearer secret-token")

    const status = await runCliToCompletion({
      cmd: ["bun", cliEntry, "status", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(status)
    expect(status.stdout).not.toContain("secret-token")
    expect(JSON.parse(status.stdout)).toMatchObject({
      connected: true,
      authenticated: true,
      profile: "codex",
      projectId: "acme-production",
    })

    const config = await readFile(join(env.XDG_CONFIG_HOME!, "sixb", "config.json"), "utf8")
    expect(config).toContain("secret-token")

    const list = await runCliToCompletion({
      cmd: ["bun", cliEntry, "profile", "list", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(list)
    expect(list.stdout).not.toContain("secret-token")
    expect(JSON.parse(list.stdout)).toMatchObject({
      currentProfile: "codex",
      profiles: [{ name: "codex", current: true, authenticated: true }],
    })

    const show = await runCliToCompletion({
      cmd: ["bun", cliEntry, "profile", "show", "codex", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(show)
    expect(show.stdout).not.toContain("secret-token")
    expect(JSON.parse(show.stdout)).toMatchObject({
      name: "codex",
      projectId: "acme-production",
      authenticated: true,
    })

    const use = await runCliToCompletion({
      cmd: ["bun", cliEntry, "profile", "use", "codex", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(use)
    expect(JSON.parse(use.stdout)).toEqual({ currentProfile: "codex" })

    const logout = await runCliToCompletion({
      cmd: ["bun", cliEntry, "logout", "--profile", "codex", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(logout)
    expect(JSON.parse(logout.stdout)).toEqual({ removedProfile: "codex" })
    const loggedOutConfig = await readFile(
      join(env.XDG_CONFIG_HOME!, "sixb", "config.json"),
      "utf8"
    )
    expect(loggedOutConfig).not.toContain("secret-token")
    expect(JSON.parse(loggedOutConfig)).toEqual({ version: 1, profiles: {} })
  }, 20_000)

  test("stores tokenless profiles for auth-disabled instances", async () => {
    const env = await tempConfigEnvironment()
    const { server, authorizationHeaders } = startProjectServer({ projectId: "local-dev" })
    const apiUrl = `http://127.0.0.1:${server.port}`

    const login = await runCliToCompletion({
      cmd: ["bun", cliEntry, "login", apiUrl, "--profile", "local", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(login)
    expect(JSON.parse(login.stdout)).toMatchObject({
      profile: "local",
      authenticated: false,
    })
    expect(authorizationHeaders).toEqual([null])

    const status = await runCliToCompletion({
      cmd: ["bun", cliEntry, "status", "--json"],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(status)
    expect(JSON.parse(status.stdout)).toMatchObject({
      connected: true,
      authenticated: false,
      profile: "local",
      projectId: "local-dev",
    })
  }, 20_000)

  test("reports an authentication failure without claiming the API is disconnected", async () => {
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

    const login = await runCliToCompletion({
      cmd: ["bun", cliEntry, "login", apiUrl, "--profile", "secured", "--token-stdin", "--json"],
      cwd: repoRoot,
      env,
      stdin: `${requiredToken}\n`,
    })
    assertCliSucceeded(login)

    requiredToken = "rotated-token"
    const status = await runCliToCompletion({
      cmd: ["bun", cliEntry, "status", "--json"],
      cwd: repoRoot,
      env,
    })

    expect(status.exitCode).toBe(1)
    expect(status.stderr).toBe("")
    expect(JSON.parse(status.stdout)).toMatchObject({
      connected: true,
      authenticated: false,
      profile: "secured",
    })
  }, 20_000)

  test("does not send a stored token with an explicit API URL", async () => {
    const env = await tempConfigEnvironment()
    const stored = startProjectServer({ token: "stored-secret", projectId: "stored" })
    const target = startProjectServer({ projectId: "target" })

    const login = await runCliToCompletion({
      cmd: [
        "bun",
        cliEntry,
        "login",
        `http://127.0.0.1:${stored.server.port}`,
        "--profile",
        "stored",
        "--token-stdin",
        "--json",
      ],
      cwd: repoRoot,
      env,
      stdin: "stored-secret\n",
    })
    assertCliSucceeded(login)

    const result = await runCliToCompletion({
      cmd: [
        "bun",
        cliEntry,
        "project",
        "show",
        "--api-url",
        `http://127.0.0.1:${target.server.port}`,
      ],
      cwd: repoRoot,
      env,
    })
    assertCliSucceeded(result)
    expect(JSON.parse(result.stdout)).toEqual({ id: "target" })
    expect(target.authorizationHeaders).toEqual([null])
  }, 20_000)

  test("does not save a profile when token validation fails", async () => {
    const env = await tempConfigEnvironment()
    const { server } = startProjectServer({ token: "correct-token" })

    const result = await runCliToCompletion({
      cmd: [
        "bun",
        cliEntry,
        "login",
        `http://127.0.0.1:${server.port}`,
        "--profile",
        "invalid",
        "--token-stdin",
        "--json",
      ],
      cwd: repoRoot,
      env,
      stdin: "wrong-token\n",
    })

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr)).toEqual({
      error: { code: "http_error", status: 401, message: "Unauthorized" },
    })
    expect(
      await readFile(join(env.XDG_CONFIG_HOME!, "sixb", "config.json"), "utf8").catch(
        () => undefined
      )
    ).toBeUndefined()
  }, 20_000)
})
