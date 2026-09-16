import { expect, test } from "bun:test"
import {
  ConnectorOAuthError,
  defineConnector,
  defineWebhook,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { flushSixbErrors } from "@sixb/core/internal/error-reporting"
import { decorateOperationScopedMethodForTesting } from "@sixb/core/internal/storage-operation-scope"
import { ConnectorCredentialCodec } from "../../core/src/connectors/connections/credential-codec"
import { createConnectorCredentialProtectorFromKey } from "../../core/src/connectors/credentials"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// Removal proof: skip OAuth connectors in WebhookRegistry; these requests return 404.
// Remove account matching in createWebhookConnections; the fan-out assertion fails.
async function harness(
  options: {
    useClient?: boolean
    disconnect?: boolean
    defaultClient?: boolean
    skipLookup?: boolean
    tokenOperation?: boolean
    rejectRefresh?: boolean
    replaceAccount?: boolean
  } = {}
) {
  const storage = new InMemoryStorage()
  const handled: string[] = []
  const errors: Error[] = []
  const tokens: string[] = []
  const encryptionKey = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")
  const protector = createConnectorCredentialProtectorFromKey(encryptionKey)
  let refreshes = 0
  let connects = 0
  let handlerCalls = 0
  const connector = defineConnector("crm", {
    type: "test-oauth",
    authentication: {
      type: "oauth2",
      authorizationUrl: () => "https://provider.test/oauth",
      exchangeCode: () => ({ accessToken: "token" }),
      refresh(_context, credentials) {
        refreshes++
        expect(credentials.refreshToken).toBe("refresh-secret")
        if (options.rejectRefresh) throw new ConnectorOAuthError("terminal", "invalid_grant")
        return {
          accessToken: "refreshed-token",
          refreshToken: "rotated-refresh",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
        }
      },
    },
    discoverAccounts: () => [],
    connect(context) {
      connects++
      return {
        accountId: context.account.id,
        async read() {
          const token = await context.tokenSource.get()
          tokens.push(token.accessToken)
        },
      }
    },
    webhooks: [
      defineWebhook("events")
        .post()
        .json({
          parse(value: unknown): { accountId: string; id: string }[] {
            if (!Array.isArray(value)) throw new Error("Expected a batch")
            return value.map((event: unknown) => {
              if (
                !event ||
                typeof event !== "object" ||
                !("accountId" in event) ||
                typeof event.accountId !== "string" ||
                !("id" in event) ||
                typeof event.id !== "string"
              ) {
                throw new Error("Invalid event")
              }
              return { accountId: event.accountId, id: event.id }
            })
          },
        })
        .verify((context) => {
          expect(context).not.toHaveProperty("sixb")
          expect(context).not.toHaveProperty("connections")
          if (context.request.headers.get("x-signature") !== "valid")
            throw new Error("Invalid signature")
        })
        .idempotencyKey(({ request }) => request.headers.get("x-delivery-id"))
        .handle<{ accountId: string; read(): Promise<void> }>(
          async ({ body, connections, client, sixb, request, rawBody }) => {
            handlerCalls++
            expect(Array.isArray(body)).toBe(true)
            expect(JSON.parse(new TextDecoder().decode(rawBody))).toEqual(body)
            expect(request.headers.get("x-signature")).toBe("valid")
            expect(sixb.execution.projectId).toBe("test-project")
            if (options.defaultClient) await client()
            for (const event of options.skipLookup ? [] : body) {
              for (const target of await connections.forAccount(event.accountId)) {
                const { connection } = target
                handled.push(`${event.id}:${connection.slot}`)
                expect(connection).not.toHaveProperty("authorizationId")
                if (options.replaceAccount) {
                  await storage.connectorConnections.putConnection({
                    id: connection.id,
                    projectId: "test-project",
                    connectorId: "crm",
                    owner: connection.owner,
                    slot: connection.slot,
                    account: { id: "b", label: "b" },
                    authorizationId: "test-project-crm-three",
                    replace: true,
                  })
                }
                if (options.disconnect) {
                  await storage.connectorConnections.disconnectConnection({
                    projectId: "test-project",
                    connectorId: "crm",
                    connectionId: connection.id,
                  })
                }
                if (options.useClient) {
                  expect((await target.client()).accountId).toBe(event.accountId)
                  expect(await target.client()).toBe(await target.client())
                  if (options.tokenOperation) await (await target.client()).read()
                }
              }
            }
            return { status: 200, headers: { "x-handled": "yes" }, body: { received: body.length } }
          }
        ),
    ],
  })
  const host = new SixbHost({
    id: "test-project",
    ontology: [],
    connectors: [connector],
    onError(error) {
      errors.push(error)
    },
    connectorConnections: { encryptionKey },
    auth: { id: "test", kind: "dev" },
    storage,
    broker: new InMemoryBroker(),
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
  async function seed(projectId: string, connectorId: string, slot: string, accountId: string) {
    const id = `${projectId}-${connectorId}-${slot}`
    await storage.connectorConnections.createAuthorization({
      id,
      projectId,
      connectorId,
      authorizedBy: { type: "user", id: "user" },
      credentials: await new ConnectorCredentialCodec({ projectId, protector }).seal(
        connectorId,
        id,
        {
          accessToken: "expired-token",
          refreshToken: "refresh-secret",
          expiresAt: new Date("2000-01-01T00:00:00Z"),
        }
      ),
      credentialExpiresAt: new Date("2000-01-01T00:00:00Z"),
      scopes: [],
      accounts: [{ id: accountId, label: accountId }],
      selectionTtlMs: 60_000,
    })
    await storage.connectorConnections.putConnection({
      id,
      projectId,
      connectorId,
      owner: { type: "project" },
      slot,
      account: { id: accountId, label: accountId },
      authorizationId: id,
      replace: false,
    })
  }
  await seed("test-project", "crm", "one", "a")
  await seed("test-project", "crm", "two", "a")
  await seed("test-project", "crm", "three", "b")
  await seed("other-project", "crm", "hidden", "a")
  await seed("test-project", "other-connector", "hidden", "a")
  return {
    handled,
    storage,
    errors,
    tokens,
    refreshCount: () => refreshes,
    async credentials(slot: string) {
      const id = `test-project-crm-${slot}`
      const authorization = await storage.connectorConnections.getAuthorization({
        projectId: "test-project",
        connectorId: "crm",
        authorizationId: id,
      })
      if (!authorization?.credentials) throw new Error("Expected stored credentials")
      return new ConnectorCredentialCodec({ projectId: "test-project", protector }).open(
        "crm",
        id,
        authorization.credentials
      )
    },
    counts: () => ({ connects, handlerCalls }),
    async send(body: unknown, signature = "valid", deliveryId = "delivery-1") {
      const response = await app.fetch(
        new Request("http://localhost/api/webhooks/crm/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-signature": signature,
            "x-delivery-id": deliveryId,
          },
          body: JSON.stringify(body),
        })
      )
      await flushSixbErrors(host)
      return response
    },
  }
}

test("routes verified batches to each selected account connection with lazy managed clients", async () => {
  const h = await harness({ useClient: true })
  const result = await h.send([
    { accountId: "a", id: "e1" },
    { accountId: "b", id: "e2" },
    { accountId: "missing", id: "e3" },
  ])
  expect(result.status).toBe(200)
  expect(result.headers.get("x-handled")).toBe("yes")
  expect(await result.json()).toEqual({ received: 3 })
  expect(h.handled).toEqual(["e1:one", "e1:two", "e2:three"])
  expect(h.counts()).toEqual({ connects: 3, handlerCalls: 1 })
})

test("verifies before handling and never creates clients for notification-only handlers", async () => {
  const h = await harness()
  expect((await h.send([{ accountId: "a", id: "e1" }], "invalid")).status).toBe(401)
  expect(h.counts()).toEqual({ connects: 0, handlerCalls: 0 })
  expect(h.handled).toEqual([])
  expect((await h.send([{ accountId: "a", id: "e1" }])).status).toBe(200)
  expect(h.counts()).toEqual({ connects: 0, handlerCalls: 1 })
})

test("rejects a disconnected target before resolving its client", async () => {
  const h = await harness({ useClient: true, disconnect: true })
  expect((await h.send([{ accountId: "a", id: "e1" }])).status).toBe(500)
  expect(h.counts().connects).toBe(0)
  expect(h.errors[0]?.cause).toMatchObject({ code: "connector.not_found" })
})

test("retains delivery-level deduplication and conflict checks", async () => {
  const h = await harness()
  const body = [{ accountId: "a", id: "e1" }]
  expect((await h.send(body)).status).toBe(200)
  expect((await h.send(body)).status).toBe(202)
  expect((await h.send([{ accountId: "b", id: "e2" }])).status).toBe(409)
  expect(h.counts().handlerCalls).toBe(1)
})

test("managed webhooks can handle payloads without requesting any connection", async () => {
  const h = await harness({ skipLookup: true })
  expect((await h.send([{ accountId: "", id: "e1" }])).status).toBe(200)
  expect(h.counts()).toEqual({ connects: 0, handlerCalls: 1 })
})

test("managed webhooks reject ambiguous default client access and empty account lookups", async () => {
  const h = await harness({ defaultClient: true })
  expect((await h.send([{ accountId: "a", id: "e1" }])).status).toBe(500)
  expect(h.counts().connects).toBe(0)
  expect(h.errors[0]?.cause).toMatchObject({ code: "connector.configuration_invalid" })
  const empty = await harness()
  expect((await empty.send([{ accountId: "", id: "e1" }])).status).toBe(500)
  expect(empty.counts().connects).toBe(0)
  expect(empty.errors[0]?.cause).toMatchObject({ code: "connector.configuration_invalid" })
})

// Removal proof: bypass tokenSource refresh in tokens.ts; the authenticated-read assertion fails.
test("webhook client operations decrypt credentials, refresh expired tokens, and persist rotation", async () => {
  const h = await harness({ useClient: true, tokenOperation: true })
  expect(h.refreshCount()).toBe(0)
  expect((await h.send([{ accountId: "b", id: "e1" }])).status).toBe(200)
  expect(h.tokens).toEqual(["refreshed-token"])
  expect(h.refreshCount()).toBe(1)
  expect(await h.credentials("three")).toMatchObject({
    accessToken: "refreshed-token",
    refreshToken: "rotated-refresh",
  })
  expect((await h.send([{ accountId: "b", id: "e2" }], "valid", "delivery-2")).status).toBe(200)
  expect(h.refreshCount()).toBe(1)
})

test("rejected refresh marks the grant for reauthorization and prevents further token use", async () => {
  const h = await harness({ useClient: true, tokenOperation: true, rejectRefresh: true })
  expect((await h.send([{ accountId: "b", id: "e1" }])).status).toBe(500)
  expect(h.errors[0]?.cause).toMatchObject({ code: "connector.authorization_required" })
  expect(h.tokens).toEqual([])
  expect(
    await h.storage.connectorConnections.getAuthorization({
      projectId: "test-project",
      connectorId: "crm",
      authorizationId: "test-project-crm-three",
    })
  ).toMatchObject({ status: "needs_reauthorization" })
  expect((await h.send([{ accountId: "b", id: "e2" }], "valid", "delivery-2")).status).toBe(500)
  expect(h.errors[1]?.cause).toMatchObject({ code: "connector.authorization_required" })
  expect(h.refreshCount()).toBe(1)
})

// Removal proof: remove the account-ID recheck in connections.ts; the stale target resolves.
test("a target cannot resolve a client after its slot changes to another account", async () => {
  const h = await harness({ useClient: true, replaceAccount: true })
  expect((await h.send([{ accountId: "a", id: "e1" }])).status).toBe(500)
  expect(h.errors[0]?.cause).toMatchObject({ code: "connector.not_found" })
  expect(h.counts().connects).toBe(0)
})

test("already disconnected accounts return no targets", async () => {
  const h = await harness({ useClient: true })
  await h.storage.connectorConnections.disconnectConnection({
    projectId: "test-project",
    connectorId: "crm",
    connectionId: "test-project-crm-three",
  })
  expect((await h.send([{ accountId: "b", id: "e1" }])).status).toBe(200)
  expect(h.handled).toEqual([])
  expect(h.counts().connects).toBe(0)
})

test("connection lookup failures reject delivery instead of returning no targets", async () => {
  const h = await harness()
  const restore = decorateOperationScopedMethodForTesting(
    h.storage.connectorConnections,
    "listConnections",
    () => async () => {
      throw new Error("lookup unavailable")
    }
  )
  try {
    expect((await h.send([{ accountId: "b", id: "e1" }])).status).toBe(500)
    expect(h.errors[0]?.cause).toMatchObject({ code: "internal.unexpected" })
    expect(h.handled).toEqual([])
  } finally {
    restore()
  }
})
