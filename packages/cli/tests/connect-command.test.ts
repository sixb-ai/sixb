import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { FAST_CLI_TIMEOUT_MS, runCliToCompletion } from "./shared/cli-process"

// `sixb connect` against a fake API: what a supervisor reads of it is its exit code and JSON lines.

const CLI = resolve(import.meta.dir, "..", "src", "index.tsx")
const cleanups: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function project() {
  const sessions: string[] = []
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
      if (path.startsWith("/api/agent-computers/sessions/")) {
        sessions.push(request.method)
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        return Response.json({ expiresAt: "2026-10-31T09:01:00.000Z", waiting: [] })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: { message() {} },
  })
  cleanups.push(() => server.stop(true))

  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-connect-command-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const notes = join(root, "notes")
  await mkdir(notes)
  return {
    notes,
    root,
    sessions,
    allowedFile: join(root, "sixb", "allowed-folders.json"),
    env: {
      XDG_CONFIG_HOME: root,
      SIXB_API_URL: `http://127.0.0.1:${server.port}`,
      SIXB_API_TOKEN: "sixb_pat_test.secret",
      SIXB_API_PUBLIC_ORIGIN: undefined,
      SIXB_TOKEN: undefined,
      SIXB_PROFILE: undefined,
    },
  }
}

describe("sixb connect", () => {
  // Guard proof: drop the check on `interactive` from allowFolders; a service manager's restart
  // allows whatever folder its command line names, with nobody asked.
  test("refuses a folder nobody allowed, when nobody can be asked", async () => {
    const { notes, env, root, sessions, allowedFile } = await project()
    const result = await runCliToCompletion({
      cmd: [process.execPath, CLI, "connect", notes],
      cwd: root,
      env,
      stdin: "",
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("isn't allowed for acme yet")
    expect(sessions).toEqual([])
    expect(await Bun.file(allowedFile).exists()).toBe(false)
  })

  // Guard proof: read every project's folders in allowFolders; connecting to a new project goes
  // straight to running messages from it in a folder chosen for another.
  test("asks again for a folder allowed only for another project", async () => {
    const { notes, env, root, sessions, allowedFile } = await project()
    await mkdir(join(root, "sixb"), { recursive: true })
    await Bun.write(allowedFile, JSON.stringify({ "acme at https://another.test": [notes] }))
    const result = await runCliToCompletion({
      cmd: [process.execPath, CLI, "connect", notes],
      cwd: root,
      env,
      stdin: "",
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("isn't allowed for acme yet")
    expect(sessions).toEqual([])
  })

  // Guard proof: offer this folder under --yes as well, in allowFolders; a service started with --yes
  // and no folder allows whatever directory it was started in, / or home included.
  test("doesn't take --yes as a choice of this folder", async () => {
    const { env, root, allowedFile } = await project()
    const result = await runCliToCompletion({
      cmd: [process.execPath, CLI, "connect", "--yes"],
      cwd: root,
      env,
      stdin: "",
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("No folders are allowed")
    expect(await Bun.file(allowedFile).exists()).toBe(false)
  })

  test("says what's wrong with a folder that doesn't exist", async () => {
    const { env, root } = await project()
    const result = await runCliToCompletion({
      cmd: [process.execPath, CLI, "connect", join(root, "missing"), "--yes"],
      cwd: root,
      env,
      stdin: "",
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("isn't a folder")
  })

  // Guard proof: leave the session open on SIGTERM, dropping stopOnHangUp from runConnect; a stopped
  // computer reads as online for a minute, and messages sent then wait with nobody told.
  test("with --yes, allows the folder, reports it as JSON, and closes its session when stopped", async () => {
    const { notes, env, root, sessions, allowedFile } = await project()
    const child = Bun.spawn([process.execPath, CLI, "connect", notes, "--yes", "--json"], {
      cwd: root,
      env: { ...process.env, ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    cleanups.push(() => child.kill("SIGKILL"))

    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    expect(JSON.parse(new TextDecoder().decode(value).split("\n")[0] ?? "")).toEqual({
      type: "folders",
      folders: [notes],
    })
    expect(JSON.parse(await readFile(allowedFile, "utf-8"))).toEqual({
      [`acme at ${env.SIXB_API_URL}`]: [notes],
    })

    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
    expect(sessions).toContain("DELETE")
  })
})
