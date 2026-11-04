import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// In its own file because it waits out the runner's real wait before it connects again, in another
// process.

const MAIN = resolve(import.meta.dir, "..", "src", "runner", "desktop-runner-main.ts")
const cleanups: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Guard proof: drop the retry from connectOrRetry; a config it can't read once leaves it alive and
// deaf, so the shell never restarts it, and a folder chosen seems to work but never takes effect.
test("the desktop runner tries again after it couldn't read its config", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-desktop-runner-e2e-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "sixb"))
  const config = join(root, "sixb", "config.json")
  await writeFile(config, "{ damaged")

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
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
      return new Response("not found", { status: 404 })
    },
    websocket: { message() {} },
  })
  cleanups.push(() => server.stop(true))

  const child = Bun.spawn([process.execPath, MAIN, `http://127.0.0.1:${server.port}`, "Acme"], {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: root,
      SIXB_API_URL: undefined,
      SIXB_API_TOKEN: undefined,
      SIXB_API_PUBLIC_ORIGIN: undefined,
      SIXB_TOKEN: undefined,
      SIXB_PROFILE: undefined,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  cleanups.push(() => child.kill("SIGKILL"))
  const killer = setTimeout(() => child.kill("SIGKILL"), 25_000)
  cleanups.push(() => clearTimeout(killer))

  let printed = ""
  let mended = false
  for await (const chunk of child.stdout) {
    printed += new TextDecoder().decode(chunk)
    if (!mended && printed.includes('"type":"error"')) {
      mended = true
      await writeFile(config, JSON.stringify({ version: 1, profiles: {} }))
    }
    if (printed.includes('"type":"connected"')) break
  }

  expect(printed).toContain('"type":"connected"')
}, 30_000)
