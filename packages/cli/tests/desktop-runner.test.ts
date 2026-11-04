import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// The runner a desktop app starts, as the process it is: what the app sees of it is JSON lines, its
// stdin and its exit code.

const MAIN = resolve(import.meta.dir, "..", "src", "runner", "desktop-runner-main.ts")
const cleanups: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const TOKENS = {
  accessToken: "sixb_at_test.access",
  refreshToken: "sixb_rt_test.refresh",
  expiresIn: 3600,
}

async function project(options: {
  readonly auth: boolean
  readonly renewals?: () => number
  /** The one token the project takes, when others have ended. */
  readonly acceptedToken?: string
  /** Answer a device login late, so that a second choice can arrive meanwhile. */
  readonly holdSignIn?: boolean
}) {
  const sessions: { readonly method: string; readonly auth: string | null }[] = []
  let approved = false
  let signInsAsked = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const path = new URL(request.url).pathname
      const auth = request.headers.get("authorization")
      if (path === "/ws/agents") {
        return server.upgrade(request) ? undefined : new Response(null, { status: 426 })
      }
      if (path === "/api/project") {
        return Response.json({ id: "acme", timeZone: "UTC", locale: "en" })
      }
      if (path === "/api/auth/session") {
        const ended = options.acceptedToken && auth !== `Bearer ${options.acceptedToken}`
        return Response.json(
          (options.auth && !auth) || ended
            ? { authenticated: false, authEnabled: true }
            : options.auth
              ? {
                  authenticated: true,
                  authEnabled: true,
                  user: { id: "usr_ava", email: "ava@example.test", displayName: "Ava" },
                }
              : { authenticated: false, authEnabled: false }
        )
      }
      if (path === "/api/auth/device-authorizations") {
        signInsAsked += 1
        if (options.holdSignIn) await Bun.sleep(50)
        const origin = new URL(request.url).origin
        return Response.json({
          deviceCode: "dev.code",
          userCode: "ABCD-EFGH",
          verificationUri: `${origin}/auth/device`,
          verificationUriComplete: `${origin}/auth/device?user_code=ABCD-EFGH`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          interval: 1,
        })
      }
      if (path === "/api/auth/device-authorizations/token") {
        return Response.json(approved ? { status: "approved", ...TOKENS } : { status: "pending" })
      }
      if (path.startsWith("/api/agent-computers/sessions/")) {
        sessions.push({ method: request.method, auth })
        if (request.method === "DELETE") return new Response(null, { status: 204 })
        const status = options.renewals?.() ?? 200
        if (status !== 200) return Response.json({ error: "[Test] No." }, { status })
        return Response.json({ expiresAt: "2026-10-31T09:01:00.000Z", waiting: [] })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: { message() {} },
  })
  cleanups.push(() => server.stop(true))

  const root = await realpath(await mkdtemp(join(tmpdir(), "sixb-desktop-runner-")))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const notes = join(root, "notes")
  await mkdir(notes)
  await mkdir(join(root, "sixb"))
  return {
    apiUrl: `http://127.0.0.1:${server.port}`,
    notes,
    root,
    sessions,
    config: join(root, "sixb", "config.json"),
    allowed: join(root, "sixb", "allowed-folders.json"),
    approve: () => {
      approved = true
    },
    signInsAsked: () => signInsAsked,
  }
}

function start(apiUrl: string, root: string) {
  const child = Bun.spawn([process.execPath, MAIN, apiUrl, "Acme on this Mac"], {
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
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000)
  cleanups.push(() => clearTimeout(killer))

  const events: Record<string, unknown>[] = []
  const waiters = new Set<() => void>()
  void (async () => {
    let rest = ""
    for await (const chunk of child.stdout) {
      rest += new TextDecoder().decode(chunk)
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const line of lines) events.push(JSON.parse(line))
      for (const wake of waiters) wake()
    }
    for (const wake of waiters) wake()
  })()
  const until = async (type: string) => {
    while (!events.some((event) => event.type === type)) {
      if (child.exitCode !== null)
        throw new Error(`Exited, without ${type}: ${JSON.stringify(events)}`)
      await new Promise<void>((resolve) => {
        waiters.add(resolve)
      })
    }
    return events.find((event) => event.type === type) as Record<string, unknown>
  }
  return {
    child,
    events,
    until,
    send: (command: unknown) => {
      child.stdin.write(`${JSON.stringify(command)}\n`)
      child.stdin.flush()
    },
  }
}

describe("the runner a desktop app starts", () => {
  // Guard proof: drop `apply` from `hear`; a folder picked in the app takes no messages until it
  // restarts. Drop the wait on stdin ending; a crashed app leaves this running turns nobody sees.
  test("says what computer this is, allows what it's told, and ends with its stdin", async () => {
    const { apiUrl, root, notes, sessions, allowed } = await project({ auth: false })
    const runner = start(apiUrl, root)

    expect(await runner.until("computer")).toMatchObject({ id: expect.stringMatching(/./) })
    await runner.until("connected")
    runner.send({ type: "allow", folder: notes })
    while (!runner.events.some((event) => (event.folders as string[] | undefined)?.length === 1)) {
      await Bun.sleep(10)
    }
    expect(JSON.parse(await readFile(allowed, "utf-8"))).toEqual({ [`acme at ${apiUrl}`]: [notes] })

    runner.child.stdin.end()
    expect(await runner.child.exited).toBe(0)
    expect(sessions.map((session) => session.method)).toContain("DELETE")
  })

  // Guard proof: sign in as it starts rather than when a folder is chosen; opening the app sends
  // everyone to their browser, whether or not they want the agent here.
  test("asks for no sign-in until a folder is chosen", async () => {
    const { apiUrl, root, signInsAsked } = await project({ auth: true })
    const runner = start(apiUrl, root)

    await runner.until("signed-out-waiting")
    runner.child.stdin.end()
    expect(await runner.child.exited).toBe(0)
    expect(signInsAsked()).toBe(0)
  })

  // Guard proof: write currentProfile in startSignInBeside; opening a desktop app points sixb at its
  // project, and later commands act on the wrong one.
  test("signs in once a folder is chosen, and leaves sixb's profile alone", async () => {
    const { apiUrl, root, notes, sessions, config, approve } = await project({ auth: true })
    const current = { apiUrl: "https://other.test", projectId: "other", token: "sixb_pat_other" }
    await writeFile(
      config,
      JSON.stringify({ version: 1, currentProfile: "other", profiles: { other: current } })
    )
    const runner = start(apiUrl, root)

    await runner.until("signed-out-waiting")
    // Approved already, so its first look at the answer needn't be followed by a wait.
    approve()
    runner.send({ type: "allow", folder: notes })
    expect(await runner.until("sign-in")).toMatchObject({
      url: `${apiUrl}/auth/device?user_code=ABCD-EFGH`,
    })
    await runner.until("connected")
    while (sessions.length === 0) await Bun.sleep(10)
    expect(sessions[0]?.auth).toBe(`Bearer ${TOKENS.accessToken}`)

    const stored = JSON.parse(await readFile(config, "utf-8"))
    expect(stored.currentProfile).toBe("other")
    expect(stored.profiles.other).toEqual(current)
    expect(stored.profiles.acme).toMatchObject({ apiUrl })
  })

  // Guard proof: answer profilesSignedInTo with nothing; someone already signed in with sixb login is
  // sent to their browser again.
  test("uses a sign-in from sixb login, with nothing to approve", async () => {
    const { apiUrl, root, notes, sessions, config, allowed } = await project({ auth: true })
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        profiles: { work: { apiUrl, projectId: "acme", token: "sixb_pat_work" } },
      })
    )
    await writeFile(allowed, JSON.stringify({ [`acme at ${apiUrl}`]: [notes] }))
    const runner = start(apiUrl, root)

    await runner.until("connected")
    while (sessions.length === 0) await Bun.sleep(10)
    expect(sessions[0]?.auth).toBe("Bearer sixb_pat_work")
    expect(runner.events.some((event) => event.type === "sign-in")).toBe(false)
  })

  // Guard proof: use only the first profile for this address, in firstThatConnects; one whose sign-in
  // has ended hides the one just approved, and each approval opens the browser for another, for good.
  test("uses the sign-in the project still takes, past one that's ended", async () => {
    const { apiUrl, root, sessions, config, allowed, notes } = await project({
      auth: true,
      acceptedToken: "sixb_pat_good",
    })
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        profiles: {
          old: { apiUrl, projectId: "acme", token: "sixb_pat_ended" },
          work: { apiUrl, projectId: "acme", token: "sixb_pat_good" },
        },
      })
    )
    await writeFile(allowed, JSON.stringify({ [`acme at ${apiUrl}`]: [notes] }))
    const runner = start(apiUrl, root)

    await runner.until("connected")
    while (sessions.length === 0) await Bun.sleep(10)
    expect(sessions[0]?.auth).toBe("Bearer sixb_pat_good")
  })

  // Guard proof: leave `signingIn` out of signIn, as `pendingSignIn` first was, set after its await;
  // two quick choices open two browser tabs, with two codes.
  test("asks for one sign-in, however many folders are chosen meanwhile", async () => {
    const { apiUrl, root, notes, signInsAsked } = await project({ auth: true, holdSignIn: true })
    const runner = start(apiUrl, root)

    await runner.until("signed-out-waiting")
    runner.send({ type: "allow", folder: notes })
    runner.send({ type: "allow", folder: notes })
    await runner.until("sign-in")
    runner.child.stdin.end()
    await runner.child.exited

    expect(signInsAsked()).toBe(1)
  })

  // Guard proof: resolve the folder for `forget` too, or queue it until signed in; a folder on an
  // unmounted volume, or anyone signed out, can't be taken back, and it takes messages again later.
  test("forgets a folder that's gone, signed out, without asking for a sign-in", async () => {
    const { apiUrl, root, allowed, signInsAsked } = await project({ auth: true })
    const gone = join(root, "unmounted")
    const kept = join(root, "kept")
    await writeFile(
      allowed,
      JSON.stringify({ [`acme at ${apiUrl}`]: [gone, kept], "other at https://other.test": [gone] })
    )
    const runner = start(apiUrl, root)

    await runner.until("signed-out-waiting")
    runner.send({ type: "forget", folder: gone })
    let stored: Record<string, string[]> = {}
    for (let turn = 0; turn < 500 && stored[`acme at ${apiUrl}`]?.length !== 1; turn += 1) {
      stored = JSON.parse(await readFile(allowed, "utf-8"))
      await Bun.sleep(10)
    }

    expect(stored[`acme at ${apiUrl}`]).toEqual([kept])
    expect(stored["other at https://other.test"]).toEqual([gone])
    runner.child.stdin.end()
    await runner.child.exited
    expect(signInsAsked()).toBe(0)
  })

  // Guard proof: drop the catch from connectOrRetry; a config it can't read takes the runner down with
  // an unhandled rejection. Whether it then tries again is in desktop-runner.e2e.ts, on a real clock.
  test("says when it can't read its config, and stays up", async () => {
    const { apiUrl, root, config } = await project({ auth: false })
    await writeFile(config, "{ damaged")
    const runner = start(apiUrl, root)

    expect(await runner.until("error")).toMatchObject({ message: expect.stringMatching(/./) })
    expect(runner.child.exitCode).toBeNull()
  })

  // Guard proof: emit signed-out without finishing; the sign-in has ended, and the app goes on showing
  // this computer as connected for good.
  test("exits 3 once its sign-in ends", async () => {
    const { apiUrl, root, notes, config, allowed } = await project({
      auth: true,
      renewals: () => 401,
    })
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        profiles: { work: { apiUrl, projectId: "acme", token: "sixb_pat_work" } },
      })
    )
    await writeFile(allowed, JSON.stringify({ [`acme at ${apiUrl}`]: [notes] }))
    const runner = start(apiUrl, root)

    await runner.until("signed-out")
    expect(await runner.child.exited).toBe(3)
  })
})
