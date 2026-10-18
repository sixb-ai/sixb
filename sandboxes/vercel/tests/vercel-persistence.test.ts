import { describe, expect, spyOn, test } from "bun:test"
import {
  type CreateSandboxOptions,
  SandboxError,
  type SandboxRequestCredential,
  SandboxStateUnavailableError,
} from "@sixb/core/sandboxes"
import { APIError } from "@vercel/sandbox"
import { persistentSandboxError } from "../src/vercel-persistence"
import { VercelSandbox } from "../src/vercel-sandbox"
import { fixture } from "./vercel-sdk-fixture"

describe("Vercel named persistence", () => {
  test("static setup runs on creation only, never on resume", async () => {
    // Regression proof: initialize only options.environment; the setup call is missing.
    const f = fixture(["prepare-once"])
    const command = spyOn(VercelSandbox.prototype, "runCommand").mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
    })
    try {
      const first = await f.factory.create({ persistence: { name: "workspace-1" } })
      expect(command).toHaveBeenCalledTimes(1)
      expect(command.mock.calls[0]?.slice(0, 2)).toEqual(["bash", ["-lc", "prepare-once"]])
      await first.stop()
      const next = await f.factory.resume("workspace-1")
      expect(command).toHaveBeenCalledTimes(1)
      await next.stop()
    } finally {
      command.mockRestore()
    }
  })

  test.each([
    "setup",
    "session configuration",
  ])("a failed %s stops the obtained session without deleting saved state", async (phase) => {
    const f = fixture(phase === "setup" ? ["prepare-once"] : undefined)
    // The transport rejects commands, exercising setup failure through the real SDK.
    if (phase !== "setup") f.failNetwork()
    await expect(f.factory.create({ persistence: { name: "workspace-1" } })).rejects.toThrow()
    expect(f.requests.some((request) => request.path.includes("session-1/stop"))).toBe(true)
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("applies initial credentials before clone without persisting them in creation defaults", async () => {
    // Regression proof: omit requestCredentials in bindPersistentSandbox's initial update.
    const f = fixture()
    const requestCredentials = [
      {
        origin: "https://github.com",
        path: "/acme/repo.git/info/refs",
        method: "GET" as const,
        headers: { Authorization: "initial-secret" },
      },
    ]
    // The fake transport rejects commands; even failed initialization must inject before clone.
    await expect(
      f.factory.create({
        persistence: { name: "workspace-1" },
        network: { mode: "restricted", allow: [{ name: "git", origin: "https://github.com" }] },
        requestCredentials,
        environment: { source: { type: "git", url: "https://github.com/acme/repo.git" } },
      })
    ).rejects.toThrow()
    const update = f.requests.findIndex((request) => request.path.includes("/network-policy"))
    const clone = f.requests.findIndex((request) => request.path.includes("/cmd"))
    expect(update).toBeGreaterThan(0)
    expect(clone).toBeGreaterThan(update)
    expect(JSON.stringify(f.requests[update]?.body)).toContain("initial-secret")
    expect(JSON.stringify(f.requests[0]?.body)).not.toContain("initial-secret")
    expect(JSON.stringify(f.requests[clone]?.body)).not.toContain("initial-secret")
  })

  test("rejects disallowed initial credentials before provisioning", async () => {
    const f = fixture()
    await expect(
      f.factory.create({
        persistence: { name: "workspace-1" },
        network: { mode: "none" },
        requestCredentials: [
          {
            origin: "https://github.com",
            path: "/acme/repo.git/info/refs",
            method: "GET",
            headers: { Authorization: "secret" },
          },
        ],
      })
    ).rejects.toThrow("Invalid request credential: the sandbox network allows no domain")
    expect(f.requests).toHaveLength(0)
  })

  test.each([
    null,
    false,
    true,
    {},
    { name: "" },
    { name: 42 },
    { name: "x", expiration: 100 },
  ])("rejects malformed persistence before provisioning: %j", async (persistence) => {
    const f = fixture()
    // Exercise JavaScript callers; removing validation must fail without making a real request.
    await expect(
      f.factory.create({ persistence } as unknown as CreateSandboxOptions)
    ).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
  })

  test("resume rejects creation options, including a typed create-options variable", async () => {
    const f = fixture()
    const options: CreateSandboxOptions = { persistence: { name: "other" }, env: {} }
    // Regression proof: remove resume's option guard; the error becomes 'saved state is unavailable'.
    // @ts-expect-error Creation options must not flow into resume through a variable either.
    await expect(f.factory.resume("workspace-1", options)).rejects.toThrow("resume accepts only")
    await expect(
      // @ts-expect-error Source is a creation setting, not a session option.
      f.factory.resume("workspace-1", { source: { type: "git", url: "https://example.com/repo" } })
    ).rejects.toThrow("resume accepts only")
    expect(f.requests).toHaveLength(0)
  })

  test("destroy explicitly deletes saved state; repeated deletion is idempotent", async () => {
    const f = fixture()
    const sandbox = await f.factory.create({ persistence: { name: "workspace-1" } })
    await sandbox.stop()
    expect(f.requests.filter((request) => request.method === "DELETE")).toHaveLength(0)
    await sandbox.destroy()
    await sandbox.destroy()
    expect(f.requests.filter((request) => request.method === "DELETE")).toHaveLength(1)
    await expect(f.factory.resume("workspace-1")).rejects.toBeInstanceOf(
      SandboxStateUnavailableError
    )
  })

  test("creates explicitly with retention, no durable run env, and a deny-all boot policy", async () => {
    const f = fixture()
    await f.factory.create({
      persistence: { name: "workspace-1" },
      env: { RUN_ACCESS: "temporary" },
    })
    expect(f.requests[0].body).toMatchObject({
      name: "workspace-1",
      persistent: true,
      env: {},
      networkPolicy: { mode: "deny-all" },
      snapshotExpiration: 604_800_000,
      keepLastSnapshots: { count: 1 },
    })
    await expect(f.factory.create({ persistence: { name: "workspace-1" } })).rejects.toThrow()
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false)
  })

  test("stop confirms the snapshot; resume opens a new pinned session with current options", async () => {
    const f = fixture()
    const first = await f.factory.create({ persistence: { name: "workspace-1" } })
    await first.writeFiles([{ path: "notes.txt", contents: "draft" }])
    await first.stop()
    const next = await f.factory.resume("workspace-1", {
      env: { RUN_ACCESS: "new" },
      network: { mode: "all" },
    })
    expect(next.id).toBe(first.id)
    await next.writeFiles([{ path: "notes.txt", contents: "revision" }])
    expect(
      f.requests
        .filter((request) => request.path.includes("/fs/write"))
        .map((request) => request.path.split("?")[0])
    ).toEqual([
      "/v2/sandboxes/sessions/session-1/fs/write",
      "/v2/sandboxes/sessions/session-2/fs/write",
    ])
    await expect(next.runCommand("env")).rejects.toThrow()
    expect(f.requests.find((request) => request.path.includes("session-2/cmd"))?.body.env).toEqual({
      DEFAULT_ENV: "current",
      RUN_ACCESS: "new",
    })
    // Regression proof: replacing the pinned Session with the named SDK handle causes an extra
    // get/resume after the stopped-command error under @vercel/sandbox 2.3.0.
    expect(
      f.requests.filter((request) => request.path.startsWith("/v2/sandboxes/workspace-1"))
    ).toHaveLength(2)
    const count = f.requests.length
    await first.stop()
    expect(f.requests).toHaveLength(count)
  })

  test.each([
    [404, "not_found"],
    [410, "snapshot_not_found"],
  ] as const)("missing state (%s/%s) never creates or deletes a replacement", async (status, code) => {
    const f = fixture()
    f.setError(status, code)
    await expect(f.factory.resume("workspace-1")).rejects.toBeInstanceOf(
      SandboxStateUnavailableError
    )
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].method).toBe("GET")
  })

  test.each([
    [403, "forbidden"],
    [404, "unknown"],
    [410, "session_stopped"],
    [401, "unauthorized"],
  ] as const)("errors %s/%s are not classified as lost state", async (status, code) => {
    const f = fixture()
    f.setError(status, code)
    const error: unknown = await f.factory.resume("workspace-1").then(
      () => undefined,
      (error: unknown) => error
    )
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).not.toBeInstanceOf(SandboxStateUnavailableError)
    expect(String(error)).toContain(`HTTP ${status}`)
    expect(String(error)).not.toContain("provider detail")
    expect(f.requests).toHaveLength(1)
  })

  test("a session configuration 404 is not evidence of lost saved state", async () => {
    // Regression proof: classify bindPersistentSandbox errors as resume errors; this fails.
    const f = fixture()
    const sandbox = await f.factory.create({ persistence: { name: "workspace-1" } })
    await sandbox.stop()
    f.loseNetworkSession()
    const error: unknown = await f.factory.resume("workspace-1").catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).not.toBeInstanceOf(SandboxStateUnavailableError)
    expect(String(error)).toContain("configure failed")
  })

  test("service failures and transport errors never signal confirmed loss", () => {
    // Test classification directly: the SDK retries 5xx responses with real backoff.
    for (const error of [
      new APIError(new Response(null, { status: 503 }), { json: { error: { code: "not_found" } } }),
      new Error("connection reset"),
    ]) {
      const mapped = persistentSandboxError(error, "resume")
      expect(mapped).toBeInstanceOf(SandboxError)
      expect(mapped).not.toBeInstanceOf(SandboxStateUnavailableError)
    }
  })

  test("a snapshot expiring between inspection and resume never triggers creation", async () => {
    const f = fixture()
    const sandbox = await f.factory.create({ persistence: { name: "workspace-1" } })
    await sandbox.stop()
    f.expireSnapshot()
    const before = f.requests.length
    await expect(f.factory.resume("workspace-1")).rejects.toBeInstanceOf(
      SandboxStateUnavailableError
    )
    expect(f.requests.slice(before).map((request) => request.method)).toEqual(["GET", "GET"])
  })

  test("never attaches to an active or non-persistent sandbox", async () => {
    const f = fixture()
    await f.factory.create({ persistence: { name: "workspace-1" } })
    await expect(f.factory.resume("workspace-1")).rejects.toThrow("must be stopped")
    f.setStatus("stopped")
    f.setPersistent(false)
    await expect(f.factory.resume("workspace-1")).rejects.toThrow("non-persistent")
    expect(f.requests.some((request) => request.path.includes("resume=true"))).toBe(false)
  })

  test.each(["failed", "missing"])("%s snapshot rejects every stop call", async (kind) => {
    const f = fixture()
    const sandbox = await f.factory.create({ persistence: { name: "workspace-1" } })
    if (kind === "failed") f.failSnapshot()
    else f.omitSnapshot()
    await expect(sandbox.stop()).rejects.toThrow("did not confirm")
    // Regression proof: restore the old stop() early return; this second assertion passes
    // incorrectly because the wrapper already marked itself stopped before snapshot completion.
    await expect(sandbox.stop()).rejects.toThrow("did not confirm")
    expect(sandbox.status).toBe("failed")
    await expect(sandbox.writeFiles([{ path: "x", contents: "x" }])).rejects.toThrow()
  })

  test("concurrent stop callers both wait for snapshot completion", async () => {
    const f = fixture()
    const sandbox = await f.factory.create({ persistence: { name: "workspace-1" } })
    let release: () => void = () => {}
    f.gateStop(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    let completed = 0
    const first = sandbox.stop().then(() => {
      completed += 1
    })
    const second = sandbox.stop().then(() => {
      completed += 1
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(completed).toBe(0)
    release()
    await Promise.all([first, second])
    expect(completed).toBe(2)
    expect(f.requests.filter((request) => request.path.includes("/stop"))).toHaveLength(1)
  })

  test("network cleanup failure still stops the VM and rejects preservation", async () => {
    const f = fixture()
    const sandbox = await f.factory.create({ persistence: { name: "workspace-1" } })
    f.failNetwork()
    await expect(sandbox.stop()).rejects.toThrow("network cleanup failed")
    expect(f.requests.some((request) => request.path.includes("/stop"))).toBe(true)
  })

  test("invalid options fail before any provider request", async () => {
    const f = fixture()
    await expect(f.factory.create({ persistence: { name: " " } })).rejects.toThrow()
    await expect(
      f.factory.resume("workspace-1", {
        network: {
          mode: "restricted",
          allow: [{ name: "local", origin: "http://localhost:3000" }],
        },
      })
    ).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
  })

  test("credentials use pinned session policy updates, never persistent defaults or guest files", async () => {
    // Regression proof: omit transforms from withRequestCredentials; the wire assertion fails.
    const f = fixture()
    const options = {
      network: {
        mode: "restricted" as const,
        allow: [{ name: "git", origin: "https://github.com" }],
      },
    }
    const sandbox = await f.factory.create({ ...options, persistence: { name: "workspace-1" } })
    const initialPolicy = f.requests.at(-1)!.body
    const credentials: SandboxRequestCredential[] = [
      {
        origin: "https://github.com",
        path: "/acme/repo.git/git-upload-pack",
        method: "POST",
        headers: { Authorization: "Basic opaque-secret" },
      },
    ]
    await sandbox.setRequestCredentials!(credentials)
    const injection = f.requests.at(-1)!
    expect(injection.path.split("?")[0]).toBe("/v2/sandboxes/sessions/session-1/network-policy")
    expect(JSON.stringify(injection.body)).toContain("opaque-secret")
    expect(JSON.stringify(injection.body)).toContain("/acme/repo.git/git-upload-pack")
    expect(JSON.stringify(injection.body)).toContain("POST")
    // The SDK sends the pinned Host as it sends Authorization.
    expect(JSON.stringify(injection.body)).toContain('"Host":"github.com"')
    expect(
      JSON.stringify(f.requests.find((r) => r.path.split("?")[0] === "/v2/sandboxes")?.body)
    ).not.toContain("opaque-secret")
    await sandbox.setRequestCredentials!([])
    expect(f.requests.at(-1)?.body).toEqual(initialPolicy)
    await sandbox.stop()
    const resumed = await f.factory.resume("workspace-1", options)
    expect(f.requests.at(-1)?.body).toEqual(initialPolicy)
    const requestCount = f.requests.length
    await expect(sandbox.setRequestCredentials!(credentials)).rejects.toThrow()
    // Regression proof: remove the wrapper's running-state guard; the stale handle sends a request.
    expect(f.requests).toHaveLength(requestCount)
    await resumed.setRequestCredentials!([
      { ...credentials[0]!, headers: { Authorization: "Basic fresh-secret" } },
    ])
    expect(f.requests.at(-1)?.path.split("?")[0]).toBe(
      "/v2/sandboxes/sessions/session-2/network-policy"
    )
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain("fresh-secret")
    expect(
      f.requests
        .filter((r) => JSON.stringify(r.body).includes("secret"))
        .every(
          (r) => r.path.includes("/sessions/") && r.path.split("?")[0]?.endsWith("/network-policy")
        )
    ).toBe(true)
    await resumed.stop()
  })

  test("credential injection failures do not expose provider request details", async () => {
    const f = fixture()
    const sandbox = await f.factory.create({
      persistence: { name: "workspace-1" },
      network: { mode: "all" },
    })
    f.failNetwork()
    await expect(
      sandbox.setRequestCredentials!([
        {
          origin: "https://github.com",
          path: "/acme/repo.git/info/refs",
          method: "GET",
          headers: { Authorization: "Basic private-token" },
        },
      ])
    ).rejects.toThrow("[Sandbox] Vercel credential injection update failed.")
  })
})
