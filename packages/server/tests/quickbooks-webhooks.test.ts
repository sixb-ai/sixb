import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
  defineConnector,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { quickbooks } from "../../../connectors/quickbooks/src"
import { ConnectorCredentialCodec } from "../../core/src/connectors/connections/credential-codec"
import { createConnectorCredentialProtectorFromKey } from "../../core/src/connectors/credentials"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

test("QuickBooks signed batches resolve selected realms and refresh encrypted managed credentials", async () => {
  // Regression proof: remove quickbooks().webhooks registration; the valid POST returns 404.
  const originalFetch = globalThis.fetch
  const storage = new InMemoryStorage()
  const encryptionKey = Buffer.alloc(32, 9).toString("base64url")
  const codec = new ConnectorCredentialCodec({
    projectId: "test-project",
    protector: createConnectorCredentialProtectorFromKey(encryptionKey),
  })
  let refreshes = 0
  let reads = 0
  let calls = 0
  const resolved: string[] = []
  const connector = defineConnector(
    "quickbooks",
    quickbooks({
      clientId: "app",
      clientSecret: "secret",
      environment: "sandbox",
      webhooks: {
        verifierToken: "verifier",
        async onEvent({ body, connections }) {
          calls++
          expect(body).toHaveLength(2)
          for (const event of body)
            for (const target of await connections.forAccount(event.intuitaccountid)) {
              resolved.push(target.connection.slot)
              const client = await target.client()
              expect(await target.client()).toBe(client)
              expect((await client.companyInfo.get()).Id).toBe("1")
            }
        },
      },
    })
  )
  const host = new SixbHost({
    id: "test-project",
    ontology: [],
    connectors: [connector],
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
  await storage.connectorConnections.createAuthorization({
    id: "grant",
    projectId: "test-project",
    connectorId: "quickbooks",
    authorizedBy: { type: "user", id: "user" },
    credentials: await codec.seal("quickbooks", "grant", {
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: new Date(0),
      authorizationContext: { realmId: "123" },
    }),
    credentialExpiresAt: new Date(0),
    scopes: ["com.intuit.quickbooks.accounting"],
    accounts: [{ id: "123", label: "Sandbox" }],
    selectionTtlMs: 60_000,
  })
  await storage.connectorConnections.putConnection({
    id: "connection",
    projectId: "test-project",
    connectorId: "quickbooks",
    owner: { type: "project" },
    slot: "accounting",
    account: { id: "123", label: "Sandbox" },
    authorizationId: "grant",
    replace: false,
  })
  const body = JSON.stringify(
    ["123", "456"].map((realm, id) => ({
      specversion: "1.0",
      id: String(id),
      source: "intuit.test",
      type: "qbo.customer.updated.v1",
      time: "2026-09-16T12:00:00Z",
      intuitaccountid: realm,
      intuitentityid: "1",
      data: {},
    }))
  )
  const send = (signature: string) =>
    app.fetch(
      new Request("http://localhost/api/webhooks/quickbooks/events", {
        method: "POST",
        headers: {
          "content-type": "application/cloudevents-batch+json",
          "intuit-signature": signature,
        },
        body,
      })
    )
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (url === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer") {
        refreshes++
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh")
        return Response.json({
          access_token: "rotated",
          refresh_token: "rotated-refresh",
          token_type: "bearer",
          expires_in: 3600,
        })
      }
      expect(url).toBe(
        "https://sandbox-quickbooks.api.intuit.com/v3/company/123/companyinfo/123?minorversion=75"
      )
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rotated")
      reads++
      return Response.json({ CompanyInfo: { Id: "1", CompanyName: "Sandbox" } })
    }) as typeof fetch
    expect((await send("invalid")).status).toBe(401)
    expect(calls).toBe(0)
    expect(refreshes).toBe(0)
    expect(
      (await send(createHmac("sha256", "verifier").update(body).digest("base64"))).status
    ).toBe(200)
    expect(resolved).toEqual(["accounting"])
    expect(calls).toBe(1)
    expect(reads).toBe(1)
    expect(refreshes).toBe(1)
    const grant = await storage.connectorConnections.getAuthorization({
      projectId: "test-project",
      connectorId: "quickbooks",
      authorizationId: "grant",
    })
    expect(await codec.open("quickbooks", "grant", grant!.credentials!)).toMatchObject({
      accessToken: "rotated",
      refreshToken: "rotated-refresh",
      authorizationContext: { realmId: "123" },
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})
