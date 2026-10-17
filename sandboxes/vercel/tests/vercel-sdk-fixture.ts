import { Sandbox as VercelSdkSandbox } from "@vercel/sandbox"
import type { VercelPersistenceOperations } from "../src/vercel-persistence"
import { createVercelSandbox, VercelSandboxFactory } from "../src/vercel-sandbox-factory"

export interface RecordedRequest {
  readonly path: string
  readonly method: string
  readonly body: Record<string, unknown>
}

/** Exercise the installed SDK over a fake transport, not a fake auto-resume implementation. */
export function fixture(setup?: readonly string[]) {
  type Status = "running" | "stopped" | "failed"
  const requests: RecordedRequest[] = []
  let status: Status = "running"
  let generation = 1
  let exists = false
  // Persistent names are chosen by the caller; ephemeral names are random and learned on create.
  let name = "workspace-1"
  let persistent = true
  let errorStatus = 0
  let errorCode = ""
  let resumeError = false
  let snapshotStatus = "created"
  let snapshotMissing = false
  let networkFails = false
  let networkMissing = false
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
    name,
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
        name = typeof body.name === "string" ? body.name : name
        return Response.json(response())
      }
      if (path === `/v2/sandboxes/${encodeURIComponent(name)}`) {
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
        if (networkMissing) return failure(404, "not_found")
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
      setup,
    },
    (params) => createVercelSandbox({ ...params, fetch }),
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
    loseNetworkSession: () => {
      networkMissing = true
    },
    gateStop: (gate: Promise<void>) => {
      stopGate = gate
    },
  }
}
