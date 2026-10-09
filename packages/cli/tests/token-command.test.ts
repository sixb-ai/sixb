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

describe("sixb token command", () => {
  test("lists tokens with SIXB_API_URL and SIXB_API_TOKEN", async () => {
    let authorizationHeader = null as string | null
    let requestedPath = ""
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requestedPath = url.pathname
        authorizationHeader = request.headers.get("authorization")
        return Response.json({
          accessTokens: [
            {
              id: "tok_cli",
              name: "Local CLI",
              kind: "personal",
              status: "active",
              subject: { type: "user", id: "usr_1" },
              createdAt: "2026-06-21T00:00:00.000Z",
              expiresAt: "2026-09-19T00:00:00.000Z",
            },
          ],
        })
      },
    })
    servers.push(server)

    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "token", "list", "--json"],
      cwd: repoRoot,
      env: {
        SIXB_API_URL: `http://127.0.0.1:${server.port}/api`,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      },
    })
    assertCliSucceeded(result)

    expect(requestedPath).toBe("/api/auth/access-tokens")
    expect(authorizationHeader).toBe("Bearer sixb_pat_tok_cli.secret")
    expect(JSON.parse(result.stdout)).toMatchObject({
      accessTokens: [{ id: "tok_cli", name: "Local CLI" }],
    })
    expect(result.stderr).toBe("")
  }, 15_000)

  test("creates a token from the profile's sign-in", async () => {
    let authorizationHeader = null as string | null
    let requestBody: unknown
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorizationHeader = request.headers.get("authorization")
        requestBody = await request.json()
        return Response.json(
          {
            accessToken: {
              id: "tok_ci",
              name: "CI",
              kind: "personal",
              status: "active",
              subject: { type: "user", id: "usr_1" },
              createdAt: "2026-06-21T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            tokenValue: "sixb_pat_tok_ci.secret",
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
      cmd: ["bun", cliEntry, "token", "create", "CI", "--expires-at", "2099-01-01T00:00:00.000Z"],
      cwd: repoRoot,
      env: profile.env,
    })
    assertCliSucceeded(result)

    expect(authorizationHeader).toBe("Bearer sixb_at_ses_cli.secret")
    expect(requestBody).toEqual({ name: "CI", expiresAt: "2099-01-01T00:00:00.000Z" })
    expect(result.stdout).toContain("sixb_pat_tok_ci.secret")
  }, 15_000)

  // Reproduce: drop `assertSignedIn` from createToken; the CLI then sends the request with the
  // access token, and this permissive server mints it.
  test("refuses to create a token with an access token", async () => {
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
      cmd: ["bun", cliEntry, "token", "create", "CI", "--json"],
      cwd: repoRoot,
      env: {
        SIXB_API_URL: `http://127.0.0.1:${server.port}`,
        SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      },
    })

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.message).toBe(
      `[SixbCLI] Creating a token requires signing in; an access token cannot create another token. Run \`sixb login http://127.0.0.1:${server.port}\`, then create the token from that profile.`
    )
    expect(requests).toBe(0)
  }, 15_000)
})
