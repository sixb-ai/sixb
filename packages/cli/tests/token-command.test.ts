import { afterEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { assertCliSucceeded, runCliToCompletion } from "./shared/cli-process"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const servers: Bun.Server<undefined>[] = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.stop(true)
  }
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
              subjectType: "user",
              subjectId: "usr_1",
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
})
