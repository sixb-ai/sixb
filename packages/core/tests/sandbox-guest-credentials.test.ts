import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import {
  GUEST_FORWARDER_NOT_RUNNING,
  type GuestCommand,
  type GuestCredentialPaths,
  type GuestCredentialsCommands,
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
        forwardedFor: request.headers.get("x-forwarded-for"),
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
  const runInstall = async ({ install, start, ready }: GuestCredentialsCommands) => {
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
  const install = (credentials: readonly SandboxRequestCredential[]) =>
    runInstall(guestCredentialsCommands(credentials, paths))
  const socketOf = () => guestCredentialedUrl(origin, paths).slice("unix:".length)
  const call = async (path: string, headers?: Record<string, string>) => {
    const response = await fetch(`http://localhost${path}`, { unix: socketOf(), headers })
    return (await response.json()) as {
      path: string
      authorization: string | null
      forwardedFor: string | null
    }
  }
  return { paths, origin, credential, install, runInstall, call, socketOf }
}

describe("guest credentials", () => {
  test("the forwarder adds the matching credential, and a new list applies at once", async () => {
    const { credential, install, call } = setup()
    const first = `guest-${randomUUID()}`
    expect(await install([credential(first)])).toBe(0)

    expect(await call("/api/whoami")).toEqual({
      path: "/api/whoami",
      authorization: `Bearer ${first}`,
      forwardedFor: null,
    })
    expect((await call("/health")).authorization).toBeNull()

    const second = `guest-${randomUUID()}`
    expect(await install([credential(second)])).toBe(0)
    expect((await call("/api/whoami")).authorization).toBe(`Bearer ${second}`)
  })

  // Guard proof: resolve the request's own URL against the origin in guestForwarder again; the
  // absolute-form request reaches the other host.
  test("forwards to its origin alone, and never says whom a request is from", async () => {
    const { credential, install, call, socketOf } = setup()
    const reached: string[] = []
    const other = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        reached.push(request.url)
        return new Response("other")
      },
    })
    try {
      expect(await install([credential(`guest-${randomUUID()}`)])).toBe(0)
      const answer = await new Promise<string>((resolve, reject) => {
        let text = ""
        Bun.connect({
          unix: socketOf(),
          socket: {
            open: (socket) => {
              socket.write(
                `GET http://127.0.0.1:${other.port}/api/x HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`
              )
            },
            data: (_socket, chunk) => {
              text += new TextDecoder().decode(chunk)
            },
            close: () => resolve(text),
            error: (_socket, error) => reject(error),
          },
        }).catch(reject)
      })

      expect(reached).toEqual([])
      expect(answer).toContain('"path":"/api/x"')
      expect(
        (await call("/api/whoami", { "x-forwarded-for": "203.0.113.9" })).forwardedFor
      ).toBeNull()
    } finally {
      other.stop(true)
    }
  })

  // Azure writes root-only files through its API: the install step then carries no secret.
  test("a provider that writes the files itself installs without them in env", async () => {
    const { paths, credential, call, runInstall } = setup()
    const secret = `guest-${randomUUID()}`
    const commands = guestCredentialsCommands([credential(secret)], paths)
    mkdirSync(paths.state, { recursive: true, mode: 0o700 })
    for (const file of commands.files) writeFileSync(file.path, file.contents, { mode: file.mode })
    const env = Object.fromEntries(
      Object.entries(commands.install.env).filter(([key]) => !commands.fileEnv.includes(key))
    )
    expect(JSON.stringify(env)).not.toContain(secret)

    expect(await runInstall({ ...commands, install: { ...commands.install, env } })).toBe(0)
    expect((await call("/api/whoami")).authorization).toBe(`Bearer ${secret}`)
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
