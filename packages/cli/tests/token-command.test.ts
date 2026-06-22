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

describe("sixb token command", () => {
  test("lists tokens with SIXB_API_URL and SIXB_API_TOKEN", async () => {
    let authorizationHeader: string | null = null
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

    const proc = Bun.spawn({
      cmd: ["bun", cliEntry, "token", "list"],
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
    expect(requestedPath).toBe("/api/auth/access-tokens")
    expect(authorizationHeader).toBe("Bearer sixb_pat_tok_cli.secret")
    expect(stdout).toContain("Local CLI")
    expect(stdout).toContain("tok_cli")
    expect(stderr).toBe("")
  })
})
