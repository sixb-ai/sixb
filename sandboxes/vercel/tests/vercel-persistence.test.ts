import { describe, expect, test } from "bun:test"
import {
  type CreateSandboxOptions,
  SandboxError,
  SandboxStateUnavailableError,
} from "@sixb/core/sandboxes"
import { Sandbox as VercelSdkSandbox } from "@vercel/sandbox"
import type { VercelPersistenceOperations } from "../src/vercel-persistence"
import { VercelSandboxFactory } from "../src/vercel-sandbox-factory"

/** Exercise the installed SDK over a fake transport, not a fake auto-resume implementation. */
function fixture() {
  type Status = "running" | "stopped" | "failed"
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = []
  let status: Status = "running"
  let generation = 1
  let exists = false
  let persistent = true
  let errorStatus = 0
  let errorCode = ""
  let resumeError = false
  let snapshotStatus = "created"
  let snapshotMissing = false
  let networkFails = false
  let stopGate: Promise<void> | undefined
  const session = () => ({
    id: `session-${generation}`,
    status,
    memory: 2048,
    vcpus: 1,
    region: "iad1",
    runtime: "node24",
    timeout: 60_000,
    requestedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    cwd: "/vercel/sandbox",
  })
  const named = () => ({
    name: "workspace-1",
    persistent,
    status,
    currentSessionId: session().id,
    createdAt: 1,
    updatedAt: 1,
  })
  const response = () => ({ sandbox: named(), session: session(), routes: [] })
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace("/api", "")
      const method = init?.method ?? "GET"
      const body: Record<string, unknown> =
        typeof init?.body === "string" ? JSON.parse(init.body) : {}
      requests.push({ path: `${path}${url.search}`, method, body })
      const failure = (status: number, code: string) =>
        Response.json({ error: { code, message: "provider detail" } }, { status })
      if (path === "/v2/sandboxes" && method === "POST") {
        if (exists) return failure(409, "conflict")
        exists = true
        return Response.json(response())
      }
      if (path === "/v2/sandboxes/workspace-1") {
        if (method === "DELETE") {
          exists = false
          return Response.json({ sandbox: named() })
        }
        if (errorStatus) return failure(errorStatus, errorCode)
        if (!exists) return failure(404, "not_found")
        if (resumeError && url.searchParams.get("resume") === "true") {
          return failure(410, "snapshot_not_found")
        }
        if (url.searchParams.get("resume") === "true" && status === "stopped") {
          generation += 1
          status = "running"
        }
        return Response.json(response())
      }
      if (path.endsWith("/network-policy")) {
        if (networkFails) return failure(400, "invalid_policy")
        return Response.json({ session: session() })
      }
      if (path.endsWith("/stop")) {
        await stopGate
        status = "stopped"
        return Response.json({
          ...response(),
          ...(snapshotMissing
            ? {}
            : {
                snapshot: {
                  id: "snapshot-1",
                  sourceSessionId: session().id,
                  region: "iad1",
                  status: snapshotStatus,
                  sizeBytes: 10,
                  createdAt: 1,
                  updatedAt: 1,
                },
              }),
        })
      }
      if (path.endsWith("/fs/write")) return Response.json({})
      if (path.includes("/cmd")) return failure(410, "session_stopped")
      throw new Error(`Unexpected SDK request: ${method} ${path}`)
    },
    { preconnect() {} }
  )
  const remote: VercelPersistenceOperations = {
    create: (params) => VercelSdkSandbox.create({ ...params, fetch }),
    get: (params) => VercelSdkSandbox.get({ ...params, fetch }),
  }
  const factory = new VercelSandboxFactory(
    {
      credentials: { token: "test", teamId: "team", projectId: "project" },
      snapshotExpiration: 7 * 24 * 60 * 60 * 1000,
      keepLastSnapshots: { count: 1 },
      env: { DEFAULT_ENV: "current" },
    },
    undefined,
    remote
  )
  return {
    factory,
    requests,
    setStatus: (value: Status) => {
      status = value
    },
    setPersistent: (value: boolean) => {
      persistent = value
    },
    setError: (status: number, code: string) => {
      errorStatus = status
      errorCode = code
    },
    failSnapshot: () => {
      snapshotStatus = "failed"
    },
    expireSnapshot: () => {
      resumeError = true
    },
    omitSnapshot: () => {
      snapshotMissing = true
    },
    failNetwork: () => {
      networkFails = true
    },
    gateStop: (gate: Promise<void>) => {
      stopGate = gate
    },
  }
}

describe("Vercel named persistence", () => {
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

  test("authorization errors are not classified as lost state", async () => {
    const f = fixture()
    f.setError(403, "forbidden")
    const error: unknown = await f.factory.resume("workspace-1").then(
      () => undefined,
      (error: unknown) => error
    )
    expect(error).toBeInstanceOf(SandboxError)
    expect(error).not.toBeInstanceOf(SandboxStateUnavailableError)
    expect(String(error)).toContain("HTTP 403")
    expect(String(error)).not.toContain("provider detail")
    expect(f.requests).toHaveLength(1)
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

  test("setup failure stops only the obtained session and preserves the named state", async () => {
    const f = fixture()
    f.failNetwork()
    await expect(f.factory.create({ persistence: { name: "workspace-1" } })).rejects.toThrow()
    expect(f.requests.some((request) => request.path.includes("session-1/stop"))).toBe(true)
    expect(f.requests.some((request) => request.method === "DELETE")).toBe(false)
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
})
