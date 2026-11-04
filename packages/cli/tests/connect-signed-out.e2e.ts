import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// In its own file because it waits out `sixb connect`'s real limit on stopping, in another process.

const CLI = resolve(import.meta.dir, "..", "src", "index.tsx")
const cleanups: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Guard proof: await computer.stop() with no limit on the signed-out path of runConnect; the stalled
// renewal keeps it from ever exiting, and a service manager never sees the code that says why.
test("sixb connect exits 3 when its sign-in ends, even with a renewal stalled", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-connect-signed-out-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const [ended, stalled] = [join(root, "ended"), join(root, "stalled")]
  await Promise.all([mkdir(ended), mkdir(stalled)])

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request, server) {
      const path = new URL(request.url).pathname
      if (path === "/ws/agents") {
        return server.upgrade(request) ? undefined : new Response(null, { status: 426 })
      }
      if (path === "/api/project") {
        return Response.json({ id: "acme", timeZone: "UTC", locale: "en" })
      }
      if (path === "/api/auth/session") {
        return Response.json({ authenticated: false, authEnabled: false })
      }
      if (path.startsWith("/api/agent-computers/sessions/") && request.method === "PUT") {
        const { computer } = (await request.json()) as { computer: { folder: string } }
        if (computer.folder === stalled) return new Promise<Response>(() => {})
        return Response.json({ error: "[Test] Signed out." }, { status: 401 })
      }
      return new Response(null, { status: 204 })
    },
    websocket: { message() {} },
  })
  cleanups.push(() => server.stop(true))

  const child = Bun.spawn([process.execPath, CLI, "connect", ended, stalled, "--yes", "--json"], {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: root,
      SIXB_API_URL: `http://127.0.0.1:${server.port}`,
      SIXB_API_TOKEN: "sixb_pat_test.secret",
      SIXB_API_PUBLIC_ORIGIN: undefined,
      SIXB_TOKEN: undefined,
      SIXB_PROFILE: undefined,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  cleanups.push(() => child.kill("SIGKILL"))
  const killer = setTimeout(() => child.kill("SIGKILL"), 25_000)
  cleanups.push(() => clearTimeout(killer))

  const [printed, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  expect(printed).toContain('"type":"signed-out"')
  expect(code).toBe(3)
}, 30_000)
