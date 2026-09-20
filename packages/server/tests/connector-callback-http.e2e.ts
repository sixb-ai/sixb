import { expect, test } from "bun:test"
import { Agent, request } from "node:http"
import { createServer } from "node:net"
import {
  can,
  defineConnector,
  defineGroup,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

async function freePort(): Promise<number> {
  const listener = createServer()
  return new Promise((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address()
      if (!address || typeof address === "string") return reject(new Error("Missing port"))
      listener.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

// Bun 1.4.2: remove server?.timeout(request, 0) in the connector callback handler and run
// bun test ./packages/server/tests/connector-callback-http.e2e.ts
// The socket closes before the 12-second exchange finishes. node:http deliberately does not
// retry the GET: automatic retries would obscure the original lost redirect behind state reuse.
for (const reused of [false, true]) {
  test(`delayed OAuth callback completes on a ${reused ? "reused" : "fresh"} HTTP connection`, async () => {
    let exchanges = 0
    const connector = defineConnector("slow-crm", {
      type: "slow-oauth",
      authentication: {
        type: "oauth2",
        authorizationUrl(_context, input) {
          const url = new URL("https://provider.test/authorize")
          url.searchParams.set("state", input.state)
          if (input.codeChallenge && input.codeChallengeMethod) {
            url.searchParams.set("code_challenge", input.codeChallenge)
            url.searchParams.set("code_challenge_method", input.codeChallengeMethod)
          }
          return url
        },
        async exchangeCode() {
          exchanges++
          await Bun.sleep(12_000)
          return { accessToken: "private-access-token", refreshToken: "private-refresh-token" }
        },
        refresh(_context, credentials) {
          return credentials
        },
        revoke() {},
      },
      discoverAccounts() {
        return [
          { id: "company-a", label: "Company A" },
          { id: "company-b", label: "Company B" },
        ]
      },
      connect() {
        return {}
      },
    })
    const managers = defineGroup("managers")
    const role = defineRole("manager", { grantedTo: [managers], grants: [can.manage(connector)] })
    const storage = new InMemoryStorage()
    const host = new SixbHost({
      id: "callback-http",
      ontology: [],
      connectors: [connector],
      groups: [managers],
      roles: [role],
      auth: { id: "test", kind: "dev" },
      storage,
      broker: new InMemoryBroker(),
      lakeStorage: new InMemoryLakeStorage(),
      blobStorage: new InMemoryBlobStorage(),
      queues: new InMemoryQueues(),
    })
    const credential = createSessionCredential("ses_manager")
    await storage.auth.users.create({
      id: "manager",
      projectId: host.id,
      email: "manager@example.test",
    })
    await storage.auth.groupMemberships.upsert({
      projectId: host.id,
      userId: "manager",
      groupId: managers.id,
      source: "manual",
    })
    await storage.auth.sessions.create({
      id: credential.sessionId,
      projectId: host.id,
      userId: "manager",
      strategyId: "test",
      audience: "atlas",
      tokenHash: credential.tokenHash,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const server = new SixbServer({
      host,
      port,
      hostname: "127.0.0.1",
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: base, atlasOrigin: base }),
    })
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const http = (
      path: string,
      options: { method?: string; cookie?: string; body?: unknown } = {}
    ) =>
      new Promise<{
        status: number
        headers: import("node:http").IncomingHttpHeaders
        body: string
        reused: boolean
      }>((resolve, reject) => {
        const req = request(
          new URL(path, base),
          {
            agent,
            method: options.method ?? "GET",
            headers: {
              origin: base,
              cookie:
                options.cookie ?? `sixb_session=${credential.cookieValue}; sixb_csrf=test-csrf`,
              "content-type": "application/json",
              "x-sixb-csrf": "test-csrf",
            },
          },
          (response) => {
            let body = ""
            response.setEncoding("utf8")
            response.on("data", (chunk) => {
              body += chunk
            })
            response.on("error", reject)
            response.on("end", () =>
              resolve({
                status: response.statusCode!,
                headers: response.headers,
                body,
                reused: req.reusedSocket,
              })
            )
          }
        )
        req.on("error", reject)
        req.setTimeout(20_000, () => req.destroy(new Error("HTTP regression timed out")))
        req.end(options.body === undefined ? undefined : JSON.stringify(options.body))
      })
    await server.start()
    try {
      const started = await http("/api/connectors/slow-crm/connection-runs", {
        method: "POST",
        body: { slot: "default", returnTo: `${base}/settings` },
      })
      expect(started.status, started.body).toBe(201)
      const { runId, authorizationUrl } = JSON.parse(started.body)
      const state = new URL(authorizationUrl).searchParams.get("state")!
      const cookie = started.headers["set-cookie"]![0].split(";", 1)[0]
      // Drain the response above before reusing its socket; force a new socket for the other case.
      if (!reused) agent.destroy()
      const path = `/auth/connectors/callback${reused ? "/" : ""}?state=${encodeURIComponent(state)}&code=private-code`
      const callback = await http(path, { cookie })
      expect(callback.reused).toBe(reused)
      expect(callback.status, callback.body).toBe(302)
      const destination = new URL(callback.headers.location!)
      expect(destination.pathname).toBe("/settings")
      expect(destination.searchParams.get("connectionRunId")).toBe(runId)
      // Settings can recover without consuming the callback URL (for example, after a lost redirect).
      const recovered = await http("/api/connectors/slow-crm/connection-runs")
      expect(recovered.status).toBe(200)
      expect(JSON.parse(recovered.body)).toMatchObject([
        { id: runId, waitingFor: "account_selection" },
      ])
      const runPath = `/api/connectors/slow-crm/connection-runs/${runId}`
      const pending = await http(runPath)
      expect(pending.status, pending.body).toBe(200)
      expect(JSON.parse(pending.body)).toMatchObject({
        status: "waiting",
        waitingFor: "account_selection",
      })
      const selected = await http(`${runPath}/selection`, {
        method: "POST",
        body: { accountId: "company-a" },
      })
      expect(selected.status, selected.body).toBe(200)
      expect(JSON.parse(selected.body)).toMatchObject({
        status: "succeeded",
        connections: [{ account: { id: "company-a" }, status: "connected" }],
      })
      const replay = await http(path, { cookie })
      expect(replay.status).toBe(400)
      expect(JSON.parse(replay.body)).toMatchObject({ code: "connector.authorization_invalid" })
      expect(exchanges).toBe(1)
    } finally {
      agent.destroy()
      await server.stop()
    }
  }, 30_000)
}
