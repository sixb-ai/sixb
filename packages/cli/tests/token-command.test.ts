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

describe("sixb tokens command", () => {
  test.concurrent("creates a token from the profile's sign-in", async () => {
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

    const result = await runCli(
      ["tokens", "create", "CI", "--expires-at", "2099-01-01T00:00:00.000Z"],
      profile.env
    )
    expect(result.exitCode, result.stderr).toBe(0)

    expect(authorizationHeader).toBe("Bearer sixb_at_ses_cli.secret")
    expect(requestBody).toEqual({ name: "CI", expiresAt: "2099-01-01T00:00:00.000Z" })
    expect(JSON.parse(result.stdout).tokenValue).toBe("sixb_pat_tok_ci.secret")
  }, 15_000)

  // Reproduce: drop `assertNotAccessToken` from tokens create; the CLI then sends the request with
  // the access token, and this permissive server mints it.
  test.concurrent("refuses to create a token with an access token", async () => {
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

    const result = await runCli(["tokens", "create", "CI", "--json"], {
      SIXB_API_URL: `http://127.0.0.1:${server.port}`,
      SIXB_API_BASE_URL: undefined,
      SIXB_API_TOKEN: "sixb_pat_tok_cli.secret",
      SIXB_RUN_ID: undefined,
    })

    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stderr).error.message).toBe(
      `Creating a token requires signing in; an access token cannot create another token. Run \`sixb login http://127.0.0.1:${server.port}\`, then create the token from that profile.`
    )
    expect(requests).toBe(0)
  }, 15_000)
})
