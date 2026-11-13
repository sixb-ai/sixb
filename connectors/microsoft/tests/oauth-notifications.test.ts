import { afterEach, describe, expect, test } from "bun:test"
import {
  type ConnectorConnectionClientContext,
  defineConnector,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { ConnectorCredentialCodec } from "../../../packages/core/src/connectors/connections/credential-codec"
import { createConnectorCredentialProtectorFromKey } from "../../../packages/core/src/connectors/credentials"
import { createSixbApi, SixbServer } from "../../../packages/server/src/server"
import { type MicrosoftOAuthEventContext, type MicrosoftOAuthEventHandler, microsoft } from "../src"
import { CLIENT_ID, CONTEXT, json, mockFetch, restoreFetch, TENANT } from "./helpers"

afterEach(restoreFetch)

const SECRET = "webhook-secret"
const ADA = "0b9a6c3e-1d2f-4a5b-8c7d-9e0f1a2b3c4d"
const GRACE = "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918"
const NOBODY = "00000000-0000-4000-8000-000000000000"
const URL = "http://localhost/api/webhooks/outlook/events"
const OAUTH = {
  tenantId: TENANT,
  clientId: CLIENT_ID,
  clientSecret: "client-secret",
  scopes: ["Mail.Read"],
}
const NOTIFICATION_URL = "https://api.example.com/api/webhooks/outlook/events"
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

/** A person's OAuth client, outside Sixb: the connector signs for the account it was given. */
async function personalClient(accountId: string, secret: string | undefined) {
  const context: ConnectorConnectionClientContext = {
    ...CONTEXT,
    connectorId: "outlook",
    connectionId: `ccn_${accountId}`,
    account: { id: accountId, label: `${accountId}@example.com` },
    tokenSource: { get: async () => ({ accessToken: "token", invalidate() {} }) },
  }
  return microsoft({
    auth: { oauth: OAUTH },
    webhookSecret: secret,
    retry: { maxRetries: 0 },
  }).connect(context)
}

/** The clientState a person's `mail.subscribe` sends to Graph. */
async function clientStateFor(accountId: string, secret = SECRET): Promise<string> {
  const requests = mockFetch(() => json({ id: `subscription-${accountId}` }, 201))
  const graph = await personalClient(accountId, secret)
  await graph.mail.subscribe(accountId, {
    changeTypes: ["created"],
    notificationUrl: NOTIFICATION_URL,
    expirationDateTime: inDays(3),
  })
  restoreFetch()
  return JSON.parse(String(requests[0]?.init.body)).clientState
}

const change = (clientState: string, accountId: string) => ({
  subscriptionId: `subscription-${accountId}`,
  tenantId: TENANT,
  clientState,
  changeType: "created",
  resource: `Users/${accountId}/Messages/m`,
  resourceData: { id: "m", "@odata.type": "#Microsoft.Graph.Message" },
})
// Graph's lifecycle notifications say nothing about the resource; clientState is all there is.
const lifecycle = (clientState: string, accountId: string) => ({
  subscriptionId: `subscription-${accountId}`,
  tenantId: TENANT,
  clientState,
  lifecycleEvent: "reauthorizationRequired",
})

async function runtime(onEvent: MicrosoftOAuthEventHandler) {
  const storage = new InMemoryStorage()
  const encryptionKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")
  const protector = createConnectorCredentialProtectorFromKey(encryptionKey)
  const connector = defineConnector(
    "outlook",
    microsoft({ auth: { oauth: OAUTH }, webhookSecret: SECRET, onEvent }),
    { owners: ["user"] }
  )
  const host = new SixbHost({
    id: "mail-test",
    ontology: [],
    connectors: [connector],
    connectorConnections: { encryptionKey },
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    onError: () => {},
  })
  const app = createSixbApi(
    new SixbServer({
      host,
      quiet: true,
      browser: { publicOrigin: "http://localhost", allowedOrigins: ["http://app.localhost"] },
    })
  )
  for (const id of ["ada", "grace"])
    await storage.auth.users.create({ projectId: "mail-test", id, email: `${id}@example.com` })
  async function connect(userId: string, slot: string, accountId: string) {
    const id = `${userId}-${slot}`
    await storage.connectorConnections.createAuthorization({
      id,
      projectId: "mail-test",
      connectorId: "outlook",
      authorizedBy: { type: "user", id: userId },
      credentials: await new ConnectorCredentialCodec({ projectId: "mail-test", protector }).seal(
        "outlook",
        id,
        {
          accessToken: `token-${userId}`,
          refreshToken: "refresh",
          expiresAt: new Date("2099-01-01"),
        }
      ),
      credentialExpiresAt: new Date("2099-01-01"),
      scopes: [],
      accounts: [{ id: accountId, label: accountId }],
      selectionTtlMs: 60_000,
    })
    await storage.connectorConnections.putConnection({
      id,
      projectId: "mail-test",
      connectorId: "outlook",
      owner: { type: "user", id: userId },
      slot,
      account: { id: accountId, label: accountId },
      authorizationId: id,
      replace: false,
    })
  }
  await connect("ada", "default", ADA)
  await connect("ada", "work", ADA)
  await connect("grace", "default", GRACE)
  const deliver = (value: unknown) =>
    app.fetch(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      })
    )
  return { deliver, storage }
}

describe("Microsoft notifications for people's own accounts", () => {
  // Countercheck: replace `await connections.forAccount(accountId)` in src/webhooks.ts with `[]`;
  // no one's connections arrive. The lifecycle item has no resource: only clientState routes it.
  test("each notification reaches the connections of the person whose subscription sent it", async () => {
    const received: MicrosoftOAuthEventContext[] = []
    const { deliver, storage } = await runtime((context) => {
      received.push(context)
    })
    const response = await deliver([
      change(await clientStateFor(ADA), ADA),
      lifecycle(await clientStateFor(GRACE), GRACE),
      change(await clientStateFor(NOBODY), NOBODY),
    ])
    expect(response.status).toBe(202)
    expect(
      received.map(({ event, accountId, connections }) => ({
        kind: event.kind,
        accountId,
        connections: connections.map(
          ({ connection }) =>
            `${connection.owner.type === "user" ? connection.owner.id : "project"}:${connection.slot}`
        ),
      }))
    ).toEqual([
      { kind: "change", accountId: ADA, connections: ["ada:default", "ada:work"] },
      { kind: "lifecycle", accountId: GRACE, connections: ["grace:default"] },
      // Someone who disconnected: their subscription lives on until it expires.
      { kind: "change", accountId: NOBODY, connections: [] },
    ])
    expect(received[0]?.event).not.toHaveProperty("clientState")
    expect((await received[1]?.connections[0]?.client())?.subscriptions).toBeDefined()
    const runs = await storage.webhookRuns.list({ projectId: "mail-test", connectorId: "outlook" })
    expect(runs.runs[0]?.status).toBe("succeeded")
  })

  // Countercheck: return the account without comparing the MAC in personalClientStateAccount;
  // the forged item names Grace and the batch is admitted.
  test("a clientState edited to name someone else rejects the whole batch", async () => {
    let calls = 0
    const { deliver, storage } = await runtime(() => {
      calls++
    })
    const ada = await clientStateFor(ADA)
    const forged = ada.replace(ADA, GRACE)
    for (const value of [
      [change(ada, ADA), change(forged, GRACE)],
      [lifecycle(await clientStateFor(ADA, "another-secret"), ADA)],
      // An application connection's value is the secret itself; it names no one.
      [change(SECRET, ADA)],
      [change(`${ada}.extra`, ADA)],
    ])
      expect((await deliver(value)).status).toBe(401)
    expect(calls).toBe(0)
    expect((await storage.webhookRuns.list({ projectId: "mail-test" })).total).toBe(0)
  })

  // Countercheck: drop the per-batch cache in microsoftOAuthEventsWebhook; lookups become 3.
  test("looks each account up once per batch", async () => {
    const seen: string[] = []
    const { deliver, storage } = await runtime(({ accountId }) => {
      seen.push(accountId)
    })
    const connections = storage.connectorConnections
    const list = connections.listConnections.bind(connections)
    let lookups = 0
    connections.listConnections = (input) => {
      lookups++
      return list(input)
    }
    const ada = await clientStateFor(ADA)
    const grace = await clientStateFor(GRACE)
    await deliver([change(ada, ADA), lifecycle(grace, GRACE), change(ada, ADA)])
    expect(seen).toEqual([ADA, GRACE, ADA])
    expect(lookups).toBe(2)
  })
})

describe("subscribing with a person's own account", () => {
  test("mail, contact and event subscriptions carry a clientState naming the connection's account", async () => {
    const requests = mockFetch(() => json({ id: "s" }, 201))
    const graph = await personalClient(ADA, SECRET)
    const options = {
      changeTypes: ["created"] as const,
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: inDays(3),
    }
    await graph.mail.subscribe(ADA, options)
    await graph.contacts.subscribe(ADA, options)
    await graph.subscriptions.create({
      resource: `users/${ADA}/events`,
      changeType: "created,updated,deleted",
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: inDays(3),
    })
    const states = requests.map((request) => JSON.parse(String(request.init.body)).clientState)
    expect(states[0]).toStartWith(`v1.${ADA}.`)
    expect(states[0].length).toBeLessThanOrEqual(128)
    expect(states.slice(1)).toEqual([states[0], states[0]])
    expect(states[0]).not.toContain(SECRET)
  })

  test("needs the webhook secret, and an account the signature can carry", async () => {
    expect(() => microsoft({ auth: { oauth: OAUTH }, onEvent() {} })).toThrow("webhookSecret")
    expect(microsoft({ auth: { oauth: OAUTH }, webhookSecret: SECRET }).webhooks).toBeUndefined()

    const requests = mockFetch(() => json({ value: [] }))
    const options = {
      changeTypes: ["created"] as const,
      notificationUrl: NOTIFICATION_URL,
      expirationDateTime: inDays(3),
    }
    const unsigned = await personalClient(ADA, undefined)
    expect(await unsigned.mail.subscribe(ADA, options).catch((error) => error)).toHaveProperty(
      "message",
      expect.stringContaining("webhookSecret is required")
    )
    // Reads keep working for an account id that isn't an Entra object id; only subscribing fails.
    const odd = await personalClient("not-an-object-id", SECRET)
    await odd.mail.messages.list("not-an-object-id")
    expect(
      await odd.mail.subscribe("not-an-object-id", options).catch((error) => error)
    ).toHaveProperty("message", expect.stringContaining("Entra object id"))
    expect(requests).toHaveLength(1)
  })
})

describe("revoking a person's connection", () => {
  const ROUTE = "https://api.example.com/api/webhooks/outlook/events"
  const credentials = (expiresAt = new Date("2099-01-01")) => ({
    accessToken: "token-ada",
    refreshToken: "refresh-ada",
    expiresAt,
    authorizationContext: { oid: ADA, preferredUsername: "ada@example.com" },
  })
  const revoke = (secret: string | undefined) =>
    microsoft({ auth: { oauth: OAUTH }, webhookSecret: secret, retry: { maxRetries: 0 } })
      .authentication.revoke
  const context = { ...CONTEXT, connectorId: "outlook" }

  function graph(
    subscriptions: readonly Record<string, unknown>[],
    onDelete = () => new Response(null, { status: 204 })
  ) {
    return mockFetch((request) => {
      if (request.url.startsWith("https://login.microsoftonline.com/"))
        return json({ access_token: "token-refreshed", expires_in: 3600 })
      if (request.method === "DELETE") return onDelete()
      return json({ value: subscriptions })
    })
  }

  // Countercheck: drop the creatorId comparison in deletePersonalSubscriptions; an administrator
  // with Subscription.Read.All would delete Grace's subscription too.
  test("deletes the subscriptions the person made to this connector's receiver, and no others", async () => {
    const requests = graph([
      { id: "mine", creatorId: ADA, notificationUrl: ROUTE },
      {
        id: "mine-behind-prefix",
        creatorId: ADA,
        notificationUrl: "https://example.com/sixb/api/webhooks/outlook/events?x=1",
      },
      { id: "mine-elsewhere", creatorId: ADA, notificationUrl: "https://example.com/hooks/graph" },
      {
        id: "other-connector",
        creatorId: ADA,
        notificationUrl: "https://api.example.com/api/webhooks/calendar/events",
      },
      { id: "grace", creatorId: GRACE, notificationUrl: ROUTE },
      { id: "unknown-creator", notificationUrl: ROUTE },
    ])
    await revoke(SECRET)?.(context, credentials())
    expect(
      requests.filter((r) => r.method === "DELETE").map((r) => r.url.split("/").pop())
    ).toEqual(["mine", "mine-behind-prefix"])
    expect(requests.every((r) => r.headers.get("authorization") === "Bearer token-ada")).toBe(true)
  })

  test("refreshes an expired token first, and needs no secret to have nothing to clean up", async () => {
    const requests = graph([{ id: "mine", creatorId: ADA, notificationUrl: ROUTE }])
    await revoke(SECRET)?.(context, credentials(new Date("2000-01-01")))
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "DELETE"])
    expect(requests[2]?.headers.get("authorization")).toBe("Bearer token-refreshed")
    expect(revoke(undefined)).toBeUndefined()
  })

  // Sixb treats a throwing revoke as a revocation to retry; cleanup must never hold one up.
  test("never fails the revocation, and says so only when something was left behind", async () => {
    const warnings: unknown[][] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args)
    try {
      // A grant Entra already refuses can't delete anything; nothing to report.
      mockFetch(() => json({ error: "invalid_grant" }, 400))
      await revoke(SECRET)?.(context, credentials(new Date("2000-01-01")))
      expect(warnings).toHaveLength(0)

      graph([{ id: "gone", creatorId: ADA, notificationUrl: ROUTE }], () =>
        json({ error: { code: "ResourceNotFound" } }, 404)
      )
      await revoke(SECRET)?.(context, credentials())
      expect(warnings).toHaveLength(0)

      graph([{ id: "stuck", creatorId: ADA, notificationUrl: ROUTE }], () =>
        json({ error: { code: "ServiceUnavailable" } }, 503)
      )
      await revoke(SECRET)?.(context, credentials())
      mockFetch(() => json({ error: { code: "ServiceUnavailable" } }, 503))
      await revoke(SECRET)?.(context, credentials())
      expect(warnings.map(([message]) => String(message))).toEqual([
        expect.stringContaining("1 subscription(s) of a revoked connection could not be deleted"),
        expect.stringContaining("could not be deleted; they expire within seven days"),
      ])
    } finally {
      console.warn = warn
    }
  })
})
