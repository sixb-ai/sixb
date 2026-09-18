import { describe, expect, test } from "bun:test"
import type { AzureSandboxCredential } from "../src"
import {
  type AzureCreateRequest,
  type AzureEgressPolicy,
  type AzureRequestOptions,
  type AzureSandboxClient,
  AzureSandboxRequestError,
  createAzureSandboxClient,
} from "../src/azure-client"

const token = { token: "synthetic-secret", expiresOnTimestamp: Date.now() + 60_000 }
const credential: AzureSandboxCredential = { getToken: async () => token }
const config = {
  subscriptionId: "subscription",
  resourceGroup: "resource-group",
  sandboxGroup: "sandbox-group",
  region: "westus3",
  credential,
}
const deny: AzureEgressPolicy = { defaultAction: "Deny", trafficInspection: "Full", hostRules: [] }
const createBody: AzureCreateRequest = {
  sourcesRef: { diskImage: { name: "node-22", isPublic: true } },
  egressPolicy: deny,
}
type Operation = (client: AzureSandboxClient, options: AzureRequestOptions) => Promise<unknown>
const operations: Record<string, Operation> = {
  create: (c, o) => c.create(createBody, o),
  get: (c, o) => c.get("sandbox", o),
  execute: (c, o) => c.execute("sandbox", "echo hello", "/tmp", o),
  write: (c, o) => c.writeFile("sandbox", "/tmp/file", "hello", 0o755, o),
  egress: (c, o) => c.setEgressPolicy("sandbox", deny, o),
  stop: (c, o) => c.stop("sandbox", o),
  delete: (c, o) => c.delete("sandbox", o),
}

describe("Azure data-plane adapter", () => {
  test("uses the scoped endpoint, data-plane audience and manual redirects", async () => {
    let scope: string | string[] | undefined
    let seenUrl: URL | undefined
    let seenInit: RequestInit | undefined
    const client = createAzureSandboxClient(
      {
        ...config,
        credential: {
          getToken: async (scopes) => {
            scope = scopes
            return token
          },
        },
      },
      {
        fetch: async (url, init) => {
          seenUrl = url
          seenInit = init
          return Response.json({ id: "sandbox", state: "Creating" }, { status: 201 })
        },
      }
    )
    expect(await client.create(createBody)).toEqual({ id: "sandbox", state: "Creating" })
    expect(scope).toBe("https://dynamicsessions.io/.default")
    expect(seenUrl?.href).toBe(
      "https://management.westus3.azuredevcompute.io/subscriptions/subscription/resourceGroups/resource-group/sandboxGroups/sandbox-group/sandboxes?api-version=2026-02-01-preview"
    )
    expect(seenInit?.method).toBe("PUT")
    expect(seenInit?.redirect).toBe("manual")
    expect(new Headers(seenInit?.headers).get("Authorization")).toBe(`Bearer ${token.token}`)
    expect(JSON.parse(String(seenInit?.body))).toEqual(createBody)
  })

  test("writes exact bytes from a subarray and decimal permissions with encoded paths", async () => {
    const client = createAzureSandboxClient(config, {
      fetch: async (url, init) => {
        expect(url.searchParams.get("path")).toBe("/tmp/a & b/ü.dat")
        expect(url.searchParams.get("createDirs")).toBe("true")
        expect(url.searchParams.get("mode")).toBe("493")
        expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream")
        expect([...(init.body as Uint8Array)]).toEqual([0, 254, 255])
        return new Response(null, { status: 204 })
      },
    })
    await client.writeFile(
      "sandbox",
      "/tmp/a & b/ü.dat",
      new Uint8Array([99, 0, 254, 255, 99]).subarray(1, 4),
      0o755
    )
  })

  test("execution preserves the request and nonzero exit without interpreting shell text", async () => {
    const command = "printf '%s' '$literal'"
    const client = createAzureSandboxClient(config, {
      fetch: async (url, init) => {
        expect(url.pathname.endsWith("/sandbox/executeShellCommand")).toBe(true)
        expect(JSON.parse(String(init.body))).toEqual({ command, workingDirectory: "/workspace" })
        return Response.json({ exitCode: 7, stdout: "out", stderr: "err" })
      },
    })
    expect(await client.execute("sandbox", command, "/workspace")).toEqual({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
    })
  })

  for (const [name, operation] of Object.entries(operations)) {
    // Reproduce regression check: replace the status guard with a retry, or remove
    // the request signal/timer. The corresponding test below must fail (or time out).
    test(`${name} sends once on 503 and redacts the response`, async () => {
      let calls = 0
      const client = createAzureSandboxClient(config, {
        fetch: async () => {
          calls++
          return new Response("private request details synthetic-secret", { status: 503 })
        },
      })
      const error = await operation(client, {}).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AzureSandboxRequestError)
      expect(error).toMatchObject({ kind: "http", statusCode: 503 })
      expect(String(error)).not.toContain("private request")
      expect(String(error)).not.toContain(token.token)
      expect(calls).toBe(1)
    })

    test(`${name} aborts its transport on deadline`, async () => {
      let signal: AbortSignal | null | undefined
      const client = createAzureSandboxClient(
        { ...config, requestTimeoutMs: 15 },
        {
          fetch: async (_, init) => {
            signal = init.signal
            // Deliberately ignore cancellation to prove the caller still receives a bound.
            return new Promise<Response>(() => {})
          },
        }
      )
      await expect(operation(client, {})).rejects.toMatchObject({ kind: "timeout" })
      expect(signal?.aborted).toBe(true)
    }, 1000)

    test(`${name} forwards caller cancellation and rejects pre-aborted requests`, async () => {
      const abort = new AbortController()
      let calls = 0
      let signal: AbortSignal | null | undefined
      const client = createAzureSandboxClient(config, {
        fetch: async (_, init) => {
          calls++
          signal = init.signal
          abort.abort("private cancellation reason")
          return new Promise<Response>(() => {})
        },
      })
      await expect(operation(client, { signal: abort.signal })).rejects.toMatchObject({
        kind: "aborted",
      })
      expect(signal?.aborted).toBe(true)
      await expect(operation(client, { signal: abort.signal })).rejects.toMatchObject({
        kind: "aborted",
      })
      expect(calls).toBe(1)
    }, 1000)
  }

  test("bounds credentials that ignore abort and never sends after they resolve late", async () => {
    let resolveToken!: (value: typeof token) => void
    let calls = 0
    const client = createAzureSandboxClient(
      {
        ...config,
        requestTimeoutMs: 15,
        credential: {
          getToken: () =>
            new Promise((resolve) => {
              resolveToken = resolve
            }),
        },
      },
      {
        fetch: async () => {
          calls++
          return Response.json({})
        },
      }
    )
    await expect(client.get("sandbox")).rejects.toMatchObject({ kind: "timeout" })
    resolveToken(token)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toBe(0)
  }, 1000)

  test("deadline covers response consumption, not just headers", async () => {
    let signal: AbortSignal | null | undefined
    const client = createAzureSandboxClient(
      { ...config, requestTimeoutMs: 15 },
      {
        fetch: async (_, init) => {
          signal = init.signal
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("{"))
              },
            })
          )
        },
      }
    )
    await expect(client.get("sandbox")).rejects.toMatchObject({ kind: "timeout" })
    expect(signal?.aborted).toBe(true)
  }, 1000)

  test("does not follow redirect responses", async () => {
    let calls = 0
    const client = createAzureSandboxClient(config, {
      fetch: async (_, init) => {
        calls++
        expect(init.redirect).toBe("manual")
        return new Response(null, {
          status: 307,
          headers: { Location: "https://untrusted.invalid" },
        })
      },
    })
    await expect(client.get("sandbox")).rejects.toMatchObject({ kind: "http", statusCode: 307 })
    expect(calls).toBe(1)
  })

  test("accepts already-deleted resources but preserves get/stop conflicts", async () => {
    const missing = createAzureSandboxClient(config, {
      fetch: async () => new Response(null, { status: 404 }),
    })
    await missing.delete("sandbox")
    await expect(missing.get("sandbox")).rejects.toMatchObject({ statusCode: 404 })
    const stopped = createAzureSandboxClient(config, {
      fetch: async () => new Response(null, { status: 409 }),
    })
    await expect(stopped.stop("sandbox")).rejects.toMatchObject({ statusCode: 409 })
  })

  test("rejects malformed successful responses and preserves unknown lifecycle states", async () => {
    const client = createAzureSandboxClient(config, {
      fetch: async () => Response.json({ id: "sandbox", state: "Disabled" }),
    })
    expect((await client.get("sandbox")).state).toBe("Disabled")
    await expect(client.execute("sandbox", "command", "/")).rejects.toMatchObject({
      kind: "response",
    })
    const malformed = createAzureSandboxClient(config, {
      fetch: async () => new Response("private malformed body"),
    })
    await expect(malformed.get("sandbox")).rejects.toMatchObject({ kind: "response" })
  })

  test("redacts credential and transport failures", async () => {
    const auth = createAzureSandboxClient({
      ...config,
      credential: {
        getToken: async () => {
          throw new Error(token.token)
        },
      },
    })
    await expect(auth.get("sandbox")).rejects.toThrow(
      "[Sandbox] Azure get failed (authentication)."
    )
    const transport = createAzureSandboxClient(config, {
      fetch: async () => {
        throw new Error(token.token)
      },
    })
    await expect(transport.get("sandbox")).rejects.toThrow(
      "[Sandbox] Azure get failed (transport)."
    )
  })

  test("rejects endpoint injection, invalid path segments and invalid deadlines", () => {
    for (const region of ["", "westus3.invalid/", "https://host", "westus3@host"]) {
      expect(() => createAzureSandboxClient({ ...config, region })).toThrow("region")
    }
    for (const sandboxGroup of ["", "../group", ".", "..", " space", "a?b"]) {
      expect(() => createAzureSandboxClient({ ...config, sandboxGroup })).toThrow("path segments")
    }
    for (const requestTimeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => createAzureSandboxClient({ ...config, requestTimeoutMs })).toThrow(
        "requestTimeoutMs"
      )
    }
  })
})
