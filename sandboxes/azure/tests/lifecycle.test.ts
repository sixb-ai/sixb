import { afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { SandboxNotRunningError } from "@sixb/core/sandboxes"
import { AzureSandboxFactory, type AzureSandboxFactoryOptions } from "../src"
import { type AzureSandboxClient, AzureSandboxRequestError } from "../src/azure-client"
import { AzureSandbox } from "../src/azure-sandbox"

import { buildGuestArtifact } from "./guest-build"

beforeAll(buildGuestArtifact, 20_000)

const config = {
  subscriptionId: "subscription",
  resourceGroup: "group",
  sandboxGroup: "sandboxes",
  region: "westus3",
  image: { type: "public", name: "node-22" },
  credential: {
    getToken: async () => ({ token: "test", expiresOnTimestamp: Date.now() + 60_000 }),
  },
  pollIntervalMs: 1,
  provisionTimeoutMs: 1000,
  teardownTimeoutMs: 100,
} satisfies AzureSandboxFactoryOptions
const lifecycle = { pollIntervalMs: 1, teardownTimeoutMs: 100 }
const absent = () => new AzureSandboxRequestError("get", "http", 404)
function client(overrides: Partial<AzureSandboxClient> = {}): AzureSandboxClient {
  return {
    create: async () => ({ id: "sandbox", state: "Running" }),
    get: async () => {
      throw absent()
    },
    execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    writeFile: async () => {},
    setEgressPolicy: async () => {},
    stop: async () => {},
    delete: async () => {},
    ...overrides,
  }
}
function session(adapter: AzureSandboxClient, timeout = 100) {
  return new AzureSandbox(
    "sandbox",
    adapter,
    { workingDirectory: "/workspace" },
    {
      ...lifecycle,
      teardownTimeoutMs: timeout,
    }
  )
}
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined
afterEach(() => fetchSpy?.mockRestore())
function transport(
  handler: (method: string, path: string, body: unknown) => Response | Promise<Response>
) {
  const replacement = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      return handler(
        init?.method ?? "GET",
        new URL(String(input)).pathname,
        typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
      )
    },
    { preconnect: globalThis.fetch.preconnect }
  )
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(replacement)
}

test("factory validates unsupported persistence and network before provisioning", async () => {
  transport(() => {
    throw new Error("must not provision")
  })
  const factory = new AzureSandboxFactory(config)
  expect("resume" in factory).toBe(false)
  await expect(factory.create({ persistence: { name: "saved" } })).rejects.toThrow("persistence")
  await expect(
    factory.create({
      network: { mode: "restricted", allow: [{ name: "bad", origin: "http://example.com" }] },
    })
  ).rejects.toThrow("HTTPS")
  await expect(factory.create({ env: { "bad=name": "x" } })).rejects.toThrow("env")
  await expect(factory.create({ workingDirectory: "\0" })).rejects.toThrow("workingDirectory")
  expect(() => new AzureSandboxFactory({ ...config, provisionTimeoutMs: 0 })).toThrow(
    "provisionTimeoutMs"
  )
  expect(
    () => new AzureSandboxFactory({ ...config, resources: { vcpus: 1, memoryMiB: 0, diskGiB: 1 } })
  ).toThrow("resources")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test.each([
  undefined,
  {},
  { setup: ["override"] },
])("factory prepares only the selected environment: %j", async (environment) => {
  transport((method, path, body) => {
    if (method === "PUT" && path.endsWith("/files")) return new Response(null, { status: 204 })
    if (method === "PUT") return Response.json({ id: "sandbox", state: "Running" })
    const { command } = body as { command: string }
    return Response.json({
      exitCode: 0,
      stdout: command.includes(" init ") ? '{"state":"ready"}' : "",
      stderr: "",
    })
  })
  const run = spyOn(AzureSandbox.prototype, "runCommand").mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 0,
  })
  try {
    const factory = new AzureSandboxFactory({ ...config, setup: ["default"] })
    await factory.create({ environment })
    const expected = environment === undefined ? "default" : environment.setup?.[0]
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual(
      expected ? [["bash", ["-lc", expected]]] : []
    )
  } finally {
    run.mockRestore()
  }
})

test("creation waits through transient absence, installs supervisor and snapshots defaults", async () => {
  let reads = 0
  const env = { BASE: "original", OVERRIDE: "old" }
  transport((method, path, body) => {
    if (method === "PUT" && path.endsWith("/files")) return new Response(null, { status: 204 })
    if (method === "PUT") {
      expect(body).toMatchObject({
        egressPolicy: { defaultAction: "Deny", trafficInspection: "Full" },
        labels: { "sixb-provider": "azure" },
        resources: { cpu: "1", memory: "1024Mi", disk: "8Gi" },
      })
      expect(JSON.stringify(body)).not.toContain("original")
      return Response.json({ id: "sandbox", state: "Creating" }, { status: 201 })
    }
    if (method === "GET") {
      if (++reads === 1) return new Response(null, { status: 404 })
      return Response.json({ id: "sandbox", state: reads === 2 ? "Creating" : "Running" })
    }
    expect(path.endsWith("/executeShellCommand")).toBe(true)
    const request = body as { command: string; workingDirectory: string }
    expect(request.workingDirectory).toBe("/")
    if (request.command.includes(" init ")) {
      expect(Buffer.from(request.command.split(" ").at(-1)!, "base64").toString()).toBe("/work/a'b")
      return Response.json({ exitCode: 0, stdout: '{"state":"ready"}', stderr: "" })
    }
    expect(request.command).toStartWith("umask 077; mkdir -- '/run/sixb-")
    return Response.json({ exitCode: 0, stdout: "", stderr: "" })
  })
  const factory = new AzureSandboxFactory({
    ...config,
    env,
    timeout: 500,
    resources: { vcpus: 1, memoryMiB: 1024, diskGiB: 8 },
  })
  env.BASE = "mutated"
  const sandbox = await factory.create({ workingDirectory: "/work/a'b", env: { OVERRIDE: "new" } })
  expect(sandbox.status).toBe("running")
  expect(sandbox).toBeInstanceOf(AzureSandbox)
  expect((sandbox as AzureSandbox).executionDefaults).toMatchObject({
    env: { BASE: "original", OVERRIDE: "new" },
    timeout: 500,
  })
  expect(reads).toBe(3)
})

for (const failure of ["Failed", "identity", "bootstrap", "deadline"]) {
  test(`failed provisioning (${failure}) deletes and confirms absence`, async () => {
    let deleted = false
    let deleteCount = 0
    let confirmations = 0
    transport((method) => {
      if (method === "PUT")
        return Response.json({
          id: "sandbox",
          state: failure === "Failed" ? "Failed" : failure === "bootstrap" ? "Running" : "Creating",
        })
      if (method === "DELETE") {
        deleted = true
        deleteCount++
        return new Response(null, { status: 202 })
      }
      if (deleted) {
        if (++confirmations === 1) return Response.json({ id: "sandbox", state: "Deleting" })
        return new Response(null, { status: 404 })
      }
      if (method === "POST") return Response.json({ exitCode: 1, stdout: "", stderr: "private" })
      return Response.json({ id: failure === "identity" ? "wrong" : "sandbox", state: "Creating" })
    })
    await expect(
      new AzureSandboxFactory({
        ...config,
        provisionTimeoutMs: failure === "deadline" ? 20 : 1000,
      }).create()
    ).rejects.toThrow()
    expect(deleteCount).toBe(1)
    expect(confirmations).toBe(2)
  })
}

test("uncertain creation is never retried and identifies its ownership label", async () => {
  let attempt = ""
  transport((_method, _path, body) => {
    attempt = (body as { labels: Record<string, string> }).labels["sixb-provisioning-id"]!
    throw new Error("private transport failure")
  })
  const failure = await new AzureSandboxFactory(config).create().catch((error: unknown) => error)
  expect(String(failure)).toContain(attempt)
  expect(String(failure)).not.toContain("private transport")
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

test("unconfirmed provisioning cleanup identifies the resource to reclaim", async () => {
  transport((method) =>
    method === "PUT"
      ? Response.json({ id: "sandbox", state: "Failed" })
      : new Response(null, { status: 403 })
  )
  await expect(new AzureSandboxFactory(config).create()).rejects.toThrow(
    "deletion of sandbox sandbox could not be confirmed"
  )
})

test("concurrent stop shares confirmation and rejects work immediately", async () => {
  let reads = 0
  let stops = 0
  const sandbox = session(
    client({
      get: async () => ({ id: "sandbox", state: ++reads < 3 ? "Running" : "Stopped" }),
      stop: async () => {
        stops++
      },
    })
  )
  const first = sandbox.stop()
  // Negative control: remove the stopPromise return guard; this identity assertion must fail.
  expect(sandbox.stop()).toBe(first)
  await expect(sandbox.runCommand("true")).rejects.toBeInstanceOf(SandboxNotRunningError)
  await expect(sandbox.writeFiles([])).rejects.toBeInstanceOf(SandboxNotRunningError)
  await first
  expect(stops).toBe(1)
  expect(reads).toBe(3)
  expect(sandbox.status).toBe("stopped")
})

test("stop conflict is confirmed, while already stopped and absent need no mutation", async () => {
  for (const initial of ["Running", "Stopped", "Suspended", "Idle", "absent"]) {
    let reads = 0
    let stops = 0
    await session(
      client({
        get: async () => {
          if (initial === "absent") throw absent()
          return { id: "sandbox", state: reads++ === 0 ? initial : "Stopped" }
        },
        stop: async () => {
          stops++
          throw new AzureSandboxRequestError("stop", "http", 409)
        },
      })
    ).stop()
    expect(stops).toBe(initial === "Running" ? 1 : 0)
  }
})

test("delete acceptance is insufficient: poll until absence, sharing outcome", async () => {
  let reads = 0
  let deletes = 0
  const sandbox = session(
    client({
      delete: async () => {
        deletes++
      },
      get: async () => {
        if (++reads === 3) throw absent()
        return { id: "sandbox", state: "Deleting" }
      },
    })
  )
  const first = sandbox.destroy()
  expect(sandbox.destroy()).toBe(first)
  expect(sandbox.stop()).toBe(first)
  await first
  expect(reads).toBe(3)
  expect(deletes).toBe(1)
})

test("destroy waits for failed stop then still reclaims; failure outcome remains shared", async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let deleted = false
  const sandbox = session(
    client({
      get: async () => {
        if (deleted) throw absent()
        await gate
        throw new AzureSandboxRequestError("get", "http", 403)
      },
      delete: async () => {
        deleted = true
      },
    })
  )
  const stop = sandbox.stop()
  const rejected = stop.catch((error: unknown) => error)
  const destroy = sandbox.destroy()
  expect(deleted).toBe(false)
  release?.()
  expect(String(await rejected)).toContain("403")
  await destroy
  expect(deleted).toBe(true)
  expect(sandbox.stop()).toBe(stop)
  expect(sandbox.status).toBe("stopped")
})

for (const operation of ["stop", "destroy"] as const) {
  test(`${operation} has a total bound and caches failures`, async () => {
    const sandbox = session(client({ get: async () => ({ id: "sandbox", state: "Running" }) }), 20)
    const first = sandbox[operation]()
    await expect(first).rejects.toThrow("timed out")
    expect(sandbox[operation]()).toBe(first)
    expect(sandbox.status).toBe("failed")
  })
  test(`${operation} never treats forbidden reads as absence`, async () => {
    const sandbox = session(
      client({
        get: async () => {
          throw new AzureSandboxRequestError("get", "http", 403)
        },
      })
    )
    await expect(sandbox[operation]()).rejects.toThrow("403")
    expect(sandbox.status).toBe("failed")
  })
}

for (const network of [
  { mode: "none" },
  { mode: "restricted", allow: [] },
  { mode: "restricted", allow: [{ name: "gateway", origin: "https://example.com" }] },
  { mode: "all" },
] as const) {
  test(`creation establishes ${JSON.stringify(network)} before returning a session`, async () => {
    let created = false
    let connected: boolean | undefined
    transport((method, path, body) => {
      if (method === "PUT" && !path.endsWith("/files")) {
        // Negative control: restore the old hard-coded deny policy in the factory.
        // Restricted/all expectations fail before any guest execution.
        expect(body).toMatchObject({
          // Azure rejected omitted resources in the live probe. Remove the
          // factory defaults to reproduce failure of this regression assertion.
          resources: { cpu: "1", memory: "2048Mi", disk: "20Gi" },
          egressPolicy: {
            defaultAction: network.mode === "all" ? "Allow" : "Deny",
            trafficInspection: network.mode === "all" ? "None" : "Full",
            hostRules:
              network.mode === "restricted"
                ? network.allow.map(() => ({ pattern: "example.com", action: "Allow" }))
                : [],
          },
        })
        created = true
        return Response.json({ id: "sandbox", state: "Running" })
      }
      expect(created).toBe(true)
      if (path.endsWith("/files")) {
        if (body instanceof Uint8Array) {
          const text = new TextDecoder().decode(body)
          if (text.startsWith('{"connected":')) connected = JSON.parse(text).connected
        }
        return new Response(null, { status: 204 })
      }
      const command = (body as { command: string }).command
      if (command.includes(" init ")) {
        expect(connected).toBe(
          network.mode === "all" || (network.mode === "restricted" && network.allow.length > 0)
        )
        return Response.json({ exitCode: 0, stdout: '{"state":"ready"}', stderr: "" })
      }
      return Response.json({ exitCode: 0, stdout: "", stderr: "" })
    })
    expect((await new AzureSandboxFactory(config).create({ network })).status).toBe("running")
  })
}
