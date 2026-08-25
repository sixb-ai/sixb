import { describe, expect, test } from "bun:test"
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
  type OntologySource,
  SixbHost,
} from "@sixb/core"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

let revokeError: Error | undefined
let revokeCount = 0

const connector = defineConnector("crm", {
  type: "test-oauth",
  authentication: {
    type: "oauth2",
    authorizationUrl(context, input) {
      const url = new URL("https://provider.test/oauth/authorize")
      url.searchParams.set("state", input.state)
      url.searchParams.set("code_challenge", input.codeChallenge)
      url.searchParams.set("code_challenge_method", input.codeChallengeMethod)
      url.searchParams.set("redirect_uri", context.redirectUri)
      return url
    },
    exchangeCode(_context, input) {
      return {
        accessToken: `access-${input.code}`,
        refreshToken: "refresh-secret",
      }
    },
    refresh(_context, credentials) {
      return credentials
    },
    revoke() {
      revokeCount += 1
      if (revokeError) throw revokeError
    },
  },
  discoverAccounts() {
    return [
      { id: "account-a", label: "Account A" },
      { id: "account-b", label: "Account B" },
    ]
  },
  connect() {
    return {}
  },
})

const staticConnector = defineConnector("static-crm", {
  type: "static-test",
  connect() {
    return {}
  },
})

const connectorManagers = defineGroup("connector-managers")
const connectorManager = defineRole("connector.manager", {
  grantedTo: [connectorManagers],
  grants: [can.manage(connector)],
})

async function createHarness() {
  revokeError = undefined
  revokeCount = 0
  const storage = new InMemoryStorage()
  const host = new SixbHost<readonly OntologySource[]>({
    id: "test-project",
    ontology: [],
    connectors: [connector],
    groups: [connectorManagers],
    roles: [connectorManager],
    auth: { id: "test", kind: "dev" },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const app = createSixbApi(
    new SixbServer({
      host,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: "http://localhost" }),
    })
  )
  const session = await seedSession(storage, "usr_manager", true)
  return {
    app,
    storage,
    session,
    setRevokeError(error: Error | undefined) {
      revokeError = error
    },
    revokeCount: () => revokeCount,
  }
}

async function createStaticHarness() {
  const storage = new InMemoryStorage()
  const host = new SixbHost<readonly OntologySource[]>({
    id: "test-project",
    ontology: [],
    connectors: [staticConnector],
    auth: { id: "test", kind: "dev" },
    broker: new InMemoryBroker(),
    storage,
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
  const app = createSixbApi(
    new SixbServer({
      host,
      quiet: true,
      browser: createTestBrowserPolicy({ apiOrigin: "http://localhost" }),
    })
  )
  return { app, session: await seedSession(storage, "usr_static", false) }
}

async function seedSession(storage: InMemoryStorage, userId: string, canManage: boolean) {
  const credential = createSessionCredential(`ses_${userId}`)
  await storage.auth.users.create({
    id: userId,
    projectId: "test-project",
    email: `${userId}@acme.com`,
  })
  if (canManage) {
    await storage.auth.groupMemberships.upsert({
      projectId: "test-project",
      userId,
      groupId: connectorManagers.id,
      source: "manual",
    })
  }
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId: "test-project",
    userId,
    strategyId: "test",
    audience: "atlas",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-08-24T10:00:00.000Z"),
    expiresAt: new Date("2099-08-24T10:00:00.000Z"),
  })
  const cookie = `sixb_session=${credential.cookieValue}`
  return {
    readHeaders: { cookie, origin: "http://atlas.localhost" },
    mutationHeaders: {
      cookie: `${cookie}; sixb_csrf=csrf_connector`,
      origin: "http://atlas.localhost",
      "x-sixb-csrf": "csrf_connector",
      "content-type": "application/json",
    },
  }
}

async function startRun(harness: Awaited<ReturnType<typeof createHarness>>, slot = "default") {
  const response = await harness.app.handle(
    new Request("http://api.localhost/api/connectors/crm/connection-runs", {
      method: "POST",
      headers: harness.session.mutationHeaders,
      body: JSON.stringify({
        slot,
        returnTo: "http://atlas.localhost/settings/connectors?tab=crm",
      }),
    })
  )
  expect(response.status, await response.clone().text()).toBe(201)
  const body = (await response.json()) as {
    readonly runId: string
    readonly authorizationUrl: string
  }
  const authorizationUrl = new URL(body.authorizationUrl)
  const setCookie = response.headers.get("set-cookie")
  expect(setCookie).toContain("HttpOnly")
  expect(setCookie).toContain("SameSite=Lax")
  return {
    ...body,
    state: authorizationUrl.searchParams.get("state")!,
    callbackCookie: setCookie!.split(";", 1)[0],
  }
}

async function completeRunAtProvider(
  harness: Awaited<ReturnType<typeof createHarness>>,
  state: string,
  callbackCookie: string,
  code = "authorization-code"
) {
  const callbackUrl = new URL("http://localhost/auth/connectors/callback")
  callbackUrl.searchParams.set("state", state)
  callbackUrl.searchParams.set("code", code)
  return harness.app.handle(
    new Request(callbackUrl, { redirect: "manual", headers: { cookie: callbackCookie } })
  )
}

async function connectAccount(
  harness: Awaited<ReturnType<typeof createHarness>>,
  slot = "default",
  accountId = "account-a"
) {
  const started = await startRun(harness, slot)
  const callback = await completeRunAtProvider(harness, started.state, started.callbackCookie)
  expect(callback.status).toBe(302)

  const selection = await harness.app.handle(
    new Request(
      `http://api.localhost/api/connectors/crm/connection-runs/${started.runId}/selection`,
      {
        method: "POST",
        headers: harness.session.mutationHeaders,
        body: JSON.stringify({ accountId }),
      }
    )
  )
  expect(selection.status, await selection.clone().text()).toBe(200)
  const run = (await selection.json()) as {
    readonly connections: readonly [{ readonly id: string }]
  }
  return { connectionId: run.connections[0].id, runId: started.runId }
}

describe("connector connection Headless API", () => {
  test("returns coded boundaries when a connector cannot have managed connections", async () => {
    const harness = await createStaticHarness()

    const staticResponse = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/static-crm/connections", {
        headers: harness.session.readHeaders,
      })
    )
    expect(staticResponse.status).toBe(400)
    expect(await staticResponse.json()).toMatchObject({
      code: "connector.configuration_invalid",
    })

    const unknownResponse = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/unknown/connections", {
        headers: harness.session.readHeaders,
      })
    )
    expect(unknownResponse.status).toBe(404)
    expect(await unknownResponse.json()).toMatchObject({ code: "connector.not_found" })
  })

  test("binds the OAuth callback to its browser and resumes account selection through a run", async () => {
    const harness = await createHarness()
    const started = await startRun(harness, "sales")

    const pending = await harness.storage.connectorConnections.getConnectionRun({
      projectId: "test-project",
      connectorId: connector.id,
      runId: started.runId,
    })
    expect(pending).toMatchObject({
      id: started.runId,
      status: "waiting",
      waitingFor: "provider_authorization",
      slot: "sales",
    })

    const withoutBinding = await completeRunAtProvider(harness, started.state, "unrelated=value")
    expect(withoutBinding.status).toBe(400)

    const callback = await completeRunAtProvider(harness, started.state, started.callbackCookie)

    expect(callback.status).toBe(302)
    expect(callback.headers.get("cache-control")).toBe("no-store")
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer")
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0")
    const destination = new URL(callback.headers.get("location")!)
    expect(destination.origin).toBe("http://atlas.localhost")
    expect(destination.pathname).toBe("/settings/connectors")
    expect(destination.searchParams.get("tab")).toBe("crm")
    expect(destination.searchParams.get("connectionRunId")).toBe(started.runId)

    const claimed = await harness.storage.connectorConnections.getConnectionRun({
      projectId: "test-project",
      connectorId: connector.id,
      runId: started.runId,
    })
    expect(claimed).toMatchObject({
      status: "waiting",
      waitingFor: "account_selection",
    })
    expect(claimed && "stateHash" in claimed).toBe(false)
    expect(claimed && "codeVerifier" in claimed).toBe(false)
    expect(claimed && "credential" in claimed).toBe(false)
    expect(claimed && "returnTo" in claimed).toBe(false)

    const runResponse = await harness.app.handle(
      new Request(`http://api.localhost/api/connectors/crm/connection-runs/${started.runId}`, {
        headers: harness.session.readHeaders,
      })
    )
    expect(runResponse.status).toBe(200)
    expect(await runResponse.json()).toMatchObject({
      id: started.runId,
      kind: "connect",
      status: "waiting",
      waitingFor: "account_selection",
      slot: "sales",
      accounts: [
        { id: "account-a", label: "Account A" },
        { id: "account-b", label: "Account B" },
      ],
    })

    const selection = await harness.app.handle(
      new Request(
        `http://api.localhost/api/connectors/crm/connection-runs/${started.runId}/selection`,
        {
          method: "POST",
          headers: harness.session.mutationHeaders,
          body: JSON.stringify({ accountId: "account-b" }),
        }
      )
    )
    expect(selection.status).toBe(200)
    expect(await selection.json()).toMatchObject({
      status: "succeeded",
      connections: [
        {
          connectorId: "crm",
          slot: "sales",
          account: { id: "account-b" },
          status: "connected",
        },
      ],
    })

    const connections = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/crm/connections", {
        headers: harness.session.readHeaders,
      })
    )
    expect(connections.status).toBe(200)
    expect(await connections.json()).toMatchObject([
      { slot: "sales", account: { id: "account-b" }, status: "connected" },
    ])
  })

  test("records provider denial as a cancelled run without exposing provider text", async () => {
    const harness = await createHarness()
    const started = await startRun(harness)
    const callbackUrl = new URL("http://localhost/auth/connectors/callback")
    callbackUrl.searchParams.set("state", started.state)
    callbackUrl.searchParams.set("error", "access_denied")
    callbackUrl.searchParams.set("error_description", "sensitive provider detail")

    const callback = await harness.app.handle(
      new Request(callbackUrl, {
        redirect: "manual",
        headers: { cookie: started.callbackCookie },
      })
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).not.toContain("sensitive")

    const run = await harness.app.handle(
      new Request(`http://api.localhost/api/connectors/crm/connection-runs/${started.runId}`, {
        headers: harness.session.readHeaders,
      })
    )
    expect(run.status).toBe(200)
    expect(await run.json()).toMatchObject({ status: "cancelled" })
  })

  test("records provider outages as safe retryable failures", async () => {
    const harness = await createHarness()
    const started = await startRun(harness)
    const callbackUrl = new URL("http://localhost/auth/connectors/callback")
    callbackUrl.searchParams.set("state", started.state)
    callbackUrl.searchParams.set("error", "temporarily_unavailable")
    callbackUrl.searchParams.set("error_description", "provider infrastructure detail")

    const callback = await harness.app.handle(
      new Request(callbackUrl, {
        redirect: "manual",
        headers: { cookie: started.callbackCookie },
      })
    )
    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).not.toContain("infrastructure")

    const run = await harness.app.handle(
      new Request(`http://api.localhost/api/connectors/crm/connection-runs/${started.runId}`, {
        headers: harness.session.readHeaders,
      })
    )
    expect(run.status).toBe(200)
    const body = await run.text()
    expect(JSON.parse(body)).toMatchObject({
      status: "failed",
      error: {
        code: "connector.provider_unavailable",
        retryable: true,
      },
    })
    expect(body).not.toContain("infrastructure")
  })

  test("authenticates the callback with one-use state", async () => {
    const harness = await createHarness()
    const started = await startRun(harness)

    const malformed = await completeRunAtProvider(harness, "invalid-state", started.callbackCookie)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ code: "connector.authorization_invalid" })

    const tampered = await completeRunAtProvider(
      harness,
      `${started.state}-tampered`,
      started.callbackCookie
    )
    expect(tampered.status).toBe(400)
    expect(await tampered.json()).toMatchObject({ code: "connector.authorization_invalid" })
    expect(
      await harness.storage.connectorConnections.getConnectionRun({
        projectId: "test-project",
        connectorId: connector.id,
        runId: started.runId,
      })
    ).toMatchObject({ status: "waiting", waitingFor: "provider_authorization" })

    const completed = await completeRunAtProvider(harness, started.state, started.callbackCookie)
    expect(completed.status).toBe(302)

    const replayed = await completeRunAtProvider(harness, started.state, started.callbackCookie)
    expect(replayed.status).toBe(400)
    expect(await replayed.json()).toMatchObject({ code: "connector.authorization_invalid" })
  })

  test("reauthorizes an existing connection and exposes the result through its run", async () => {
    const harness = await createHarness()
    const connected = await connectAccount(harness, "sales", "account-b")

    const start = await harness.app.handle(
      new Request(
        `http://api.localhost/api/connectors/crm/connections/${connected.connectionId}/reauthorize`,
        {
          method: "POST",
          headers: harness.session.mutationHeaders,
          body: JSON.stringify({
            returnTo: "http://atlas.localhost/settings/connectors?tab=crm",
          }),
        }
      )
    )
    expect(start.status, await start.clone().text()).toBe(201)
    const started = (await start.json()) as {
      readonly runId: string
      readonly authorizationUrl: string
      readonly affectedConnections: readonly [{ readonly id: string }]
    }
    expect(started.affectedConnections).toMatchObject([{ id: connected.connectionId }])

    const state = new URL(started.authorizationUrl).searchParams.get("state")!
    const callbackCookie = start.headers.get("set-cookie")!.split(";", 1)[0]
    const callback = await completeRunAtProvider(
      harness,
      state,
      callbackCookie,
      "reauthorization-code"
    )
    expect(callback.status).toBe(302)

    const run = await harness.app.handle(
      new Request(`http://api.localhost/api/connectors/crm/connection-runs/${started.runId}`, {
        headers: harness.session.readHeaders,
      })
    )
    expect(run.status).toBe(200)
    expect(await run.json()).toMatchObject({
      id: started.runId,
      kind: "reauthorize",
      status: "succeeded",
      connections: [{ id: connected.connectionId, status: "connected" }],
    })
  })

  test("disconnects one connection without revoking its provider authorization", async () => {
    const harness = await createHarness()
    const connected = await connectAccount(harness)

    const response = await harness.app.handle(
      new Request(`http://api.localhost/api/connectors/crm/connections/${connected.connectionId}`, {
        method: "DELETE",
        headers: harness.session.mutationHeaders,
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })

    const connections = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/crm/connections", {
        headers: harness.session.readHeaders,
      })
    )
    expect(await connections.json()).toEqual([])
  })

  test("revokes the provider authorization and returns every disconnected connection", async () => {
    const harness = await createHarness()
    const connected = await connectAccount(harness)

    const response = await harness.app.handle(
      new Request(
        `http://api.localhost/api/connectors/crm/connections/${connected.connectionId}/revoke`,
        {
          method: "POST",
          headers: harness.session.mutationHeaders,
        }
      )
    )
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({
      affectedConnections: [{ id: connected.connectionId, status: "disconnected" }],
    })

    const connections = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/crm/connections", {
        headers: harness.session.readHeaders,
      })
    )
    expect(await connections.json()).toEqual([])
  })

  test("retries provider revocation through the former connection id", async () => {
    const harness = await createHarness()
    const connected = await connectAccount(harness)
    const url = `http://api.localhost/api/connectors/crm/connections/${connected.connectionId}/revoke`

    harness.setRevokeError(new Error("temporary provider outage"))
    const failed = await harness.app.handle(
      new Request(url, { method: "POST", headers: harness.session.mutationHeaders })
    )
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ code: "connector.revocation_pending" })

    harness.setRevokeError(undefined)
    const retried = await harness.app.handle(
      new Request(url, { method: "POST", headers: harness.session.mutationHeaders })
    )
    expect(retried.status, await retried.clone().text()).toBe(200)
    expect(await retried.json()).toMatchObject({
      affectedConnections: [{ id: connected.connectionId, status: "disconnected" }],
    })
    expect(harness.revokeCount()).toBe(2)

    const repeated = await harness.app.handle(
      new Request(url, { method: "POST", headers: harness.session.mutationHeaders })
    )
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({
      affectedConnections: [{ id: connected.connectionId, status: "disconnected" }],
    })
    expect(harness.revokeCount()).toBe(2)

    const authorization = await harness.storage.connectorConnections.getAuthorizationByConnectionId(
      {
        projectId: "test-project",
        connectorId: connector.id,
        connectionId: connected.connectionId,
      }
    )
    expect(authorization).toMatchObject({ status: "revoked", credentials: undefined })
  })

  test("requires CSRF and connector management permission before creating a run", async () => {
    const harness = await createHarness()
    const response = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/crm/connection-runs", {
        method: "POST",
        headers: {
          ...harness.session.readHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          slot: "default",
          returnTo: "http://atlas.localhost/settings/connectors",
        }),
      })
    )
    expect(response.status).toBe(403)

    const withoutGrant = await seedSession(harness.storage, "usr_without_grant", false)
    const forbidden = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/crm/connection-runs", {
        method: "POST",
        headers: withoutGrant.mutationHeaders,
        body: JSON.stringify({
          slot: "default",
          returnTo: "http://atlas.localhost/settings/connectors",
        }),
      })
    )
    expect(forbidden.status).toBe(403)
  })

  test("keeps a run private to the manager who initiated it", async () => {
    const harness = await createHarness()
    const started = await startRun(harness)
    const anotherManager = await seedSession(harness.storage, "usr_another_manager", true)

    const response = await harness.app.handle(
      new Request(`http://api.localhost/api/connectors/crm/connection-runs/${started.runId}`, {
        headers: anotherManager.readHeaders,
      })
    )
    expect(response.status).toBe(403)
  })

  test("rejects a return target outside the initiating browser audience", async () => {
    const harness = await createHarness()
    const response = await harness.app.handle(
      new Request("http://api.localhost/api/connectors/crm/connection-runs", {
        method: "POST",
        headers: harness.session.mutationHeaders,
        body: JSON.stringify({
          slot: "default",
          returnTo: "https://attacker.example/callback",
        }),
      })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "[SixbServer] Auth return target is not allowed.",
    })
  })
})
