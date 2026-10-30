import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import {
  GUEST_FORWARDER_NOT_RUNNING,
  type GuestCommand,
  type GuestCredentialPaths,
  guestCredentialedUrl,
  guestCredentialsCommands,
  type SandboxRequestCredential,
} from "../src/sandboxes"

// The guest's install script and forwarder, run here as a guest's root would run them: the paths
// are the only difference, so the program a VM runs is the one under test.

let root: string | undefined
let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
  if (!root) return
  const pid = Number(readFileSync(`${root}/state/forwarder.pid`, "utf8"))
  if (pid > 0) process.kill(pid)
  rmSync(root, { recursive: true, force: true })
  root = undefined
})

function setup() {
  // Under /tmp: a socket's path must fit in about 100 bytes.
  root = mkdtempSync("/tmp/sixb-guest-")
  const paths: GuestCredentialPaths = { state: `${root}/state`, sockets: `${root}/sockets` }
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      Response.json({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
      }),
  })
  const origin = `http://127.0.0.1:${server.port}`
  const credential = (secret: string): SandboxRequestCredential => ({
    origin,
    path: { prefix: "/api/" },
    method: ["GET", "POST"],
    headers: { Authorization: `Bearer ${secret}` },
  })
  const run = async (command: GuestCommand) => {
    const child = Bun.spawn([...command.argv], {
      env: { PATH: process.env.PATH ?? "", ...command.env },
    })
    const killer = setTimeout(() => child.kill(), 10_000)
    try {
      return await child.exited
    } finally {
      clearTimeout(killer)
    }
  }
  // As a provider runs them: the start step only when no forwarder runs, left running.
  const install = async (credentials: readonly SandboxRequestCredential[]) => {
    const { install, start, ready } = guestCredentialsCommands(credentials, paths)
    const installed = await run(install)
    if (installed === GUEST_FORWARDER_NOT_RUNNING) {
      Bun.spawn([...start.argv], {
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "ignore", "ignore"],
      })
    } else if (installed !== 0) {
      return installed
    }
    return run(ready)
  }
  const call = async (path: string) => {
    const socket = guestCredentialedUrl(origin, paths).slice("unix:".length)
    const response = await fetch(`http://localhost${path}`, { unix: socket })
    return (await response.json()) as { path: string; authorization: string | null }
  }
  return { paths, origin, credential, install, call }
}

describe("guest credentials", () => {
  test("the forwarder adds the matching credential, and a new list applies at once", async () => {
    const { credential, install, call } = setup()
    const first = `guest-${randomUUID()}`
    expect(await install([credential(first)])).toBe(0)

    expect(await call("/api/whoami")).toEqual({
      path: "/api/whoami",
      authorization: `Bearer ${first}`,
    })
    expect((await call("/health")).authorization).toBeNull()

    const second = `guest-${randomUUID()}`
    expect(await install([credential(second)])).toBe(0)
    expect((await call("/api/whoami")).authorization).toBe(`Bearer ${second}`)
  })

  test("keeps the credentials root-only and out of the forwarder's arguments", async () => {
    const { paths, credential, install } = setup()
    const secret = `guest-${randomUUID()}`
    expect(await install([credential(secret)])).toBe(0)

    expect(statSync(paths.state).mode & 0o777).toBe(0o700)
    expect(statSync(`${paths.state}/credentials.json`).mode & 0o777).toBe(0o600)
    expect(statSync(paths.sockets).mode & 0o777).toBe(0o755)
    const pid = readFileSync(`${paths.state}/forwarder.pid`, "utf8").trim()
    const ps = Bun.spawn(["ps", "-o", "args=", "-p", pid], { stdout: "pipe" })
    const args = await new Response(ps.stdout).text()
    expect(args).toContain("forwarder.mjs")
    expect(args).not.toContain(secret)
  })
})
