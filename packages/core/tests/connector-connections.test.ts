import { describe, expect, test } from "bun:test"
import {
  type ConnectorAuthorizationStatus,
  type ConnectorConnectionOwner,
  type ConnectorConnectionStatus,
  connectorConnectionOwnerKey,
  connectorConnectionStatus,
  createConnectorAuthorizationAttemptId,
  createConnectorAuthorizationId,
  createConnectorConnectionId,
  InMemoryStorage,
  type SealedEnvelope,
} from "../src/storage"

const ENVELOPE: SealedEnvelope = {
  version: 1,
  algorithm: "aes-256-gcm",
  keyId: "test-key",
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "Y2lwaGVy",
  tag: "BBBBBBBBBBBBBBBBBBBBBB==",
}

const AT = new Date("2026-06-01T12:00:00.000Z")

describe("connector connection owner keys", () => {
  test("separates the three owner kinds", () => {
    const keys = [
      connectorConnectionOwnerKey({ type: "project" }),
      connectorConnectionOwnerKey({
        type: "principal",
        principal: { type: "user", id: "u1" },
      }),
      connectorConnectionOwnerKey({
        type: "object",
        ref: { objectTypeId: "Client", primaryId: "c1" },
      }),
    ]
    expect(new Set(keys).size).toBe(3)
  })

  test("a user and a service account with the same id are different owners", () => {
    expect(
      connectorConnectionOwnerKey({ type: "principal", principal: { type: "user", id: "a" } })
    ).not.toBe(
      connectorConnectionOwnerKey({
        type: "principal",
        principal: { type: "serviceAccount", id: "a" },
      })
    )
  })

  test("ids containing the delimiter cannot collide across owners", () => {
    // `objectRefKey` serializes through JSON precisely so a colon inside an id cannot be read as
    // a field separator. Without that, these two owners would produce the same key.
    const first = connectorConnectionOwnerKey({
      type: "object",
      ref: { objectTypeId: "Client", primaryId: 'c1","Client' },
    })
    const second = connectorConnectionOwnerKey({
      type: "object",
      ref: { objectTypeId: 'Client","c1', primaryId: "Client" },
    })
    expect(first).not.toBe(second)
  })

  test("is stable for the same owner", () => {
    const owner: ConnectorConnectionOwner = {
      type: "object",
      ref: { objectTypeId: "Client", primaryId: "c1" },
    }
    expect(connectorConnectionOwnerKey(owner)).toBe(connectorConnectionOwnerKey({ ...owner }))
  })
})

describe("connector connection ids", () => {
  test("are prefixed and unique per kind", () => {
    expect(createConnectorAuthorizationAttemptId()).toStartWith("connattempt_")
    expect(createConnectorAuthorizationId()).toStartWith("connauth_")
    expect(createConnectorConnectionId()).toStartWith("conn_")
    expect(createConnectorConnectionId()).not.toBe(createConnectorConnectionId())
  })
})

describe("connector connection status", () => {
  test("a live connection follows its grant", () => {
    const cases: Array<[ConnectorAuthorizationStatus, ConnectorConnectionStatus]> = [
      ["active", "connected"],
      ["superseded", "needs_reauthorization"],
      ["invalid", "needs_reauthorization"],
      ["revoked", "revoked"],
    ]
    for (const [status, expected] of cases) {
      expect(connectorConnectionStatus({ disconnectedAt: undefined }, { status })).toBe(expected)
    }
  })

  test("a disconnected connection stays disconnected whatever the grant says", () => {
    // Deriving is what makes a terminal refresh failure reach every attached connection without a
    // fan-out write; disconnection is the one fact that still has to be stored per connection.
    for (const status of ["active", "superseded", "invalid", "revoked"] as const) {
      expect(connectorConnectionStatus({ disconnectedAt: AT }, { status })).toBe("disconnected")
    }
  })
})

describe("connector connections in InMemoryStorage", () => {
  test("rolls back connector connections with in-memory storage transactions", async () => {
    // Guards the snapshot/restore wiring in `InMemoryStorage`. Rollback works off the raw stores,
    // so this does NOT also cover the operation-scope wrapper — the test below does that.
    const storage = new InMemoryStorage()

    await expect(
      storage.transaction(async (tx) => {
        await tx.connectorConnections!.authorizations.create({
          id: "connauth_rollback",
          projectId: "test-project",
          connectorId: "tiktok",
          authorizedBy: { type: "user", id: "u1" },
          scopes: ["video.list"],
          credentials: ENVELOPE,
          createdAt: AT,
        })
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")

    await expect(
      storage.connectorConnections.authorizations.getById({
        projectId: "test-project",
        id: "connauth_rollback",
      })
    ).resolves.toBeNull()
  })

  test("commits connector connections when the transaction succeeds", async () => {
    const storage = new InMemoryStorage()

    await storage.transaction(async (tx) => {
      await tx.connectorConnections!.authorizations.create({
        id: "connauth_kept",
        projectId: "test-project",
        connectorId: "tiktok",
        authorizedBy: { type: "user", id: "u1" },
        scopes: ["video.list"],
        credentials: ENVELOPE,
        createdAt: AT,
      })
      await tx.connectorConnections!.connections.upsert({
        id: "conn_kept",
        projectId: "test-project",
        connectorId: "tiktok",
        owner: { type: "project" },
        slot: "social",
        authorizationId: "connauth_kept",
        externalAccountId: "account-a",
        at: AT,
      })
    })

    await expect(
      storage.connectorConnections.authorizations.getById({
        projectId: "test-project",
        id: "connauth_kept",
      })
    ).resolves.toMatchObject({ status: "active", revision: 1 })
    await expect(
      storage.connectorConnections.connections.getBySlot({
        projectId: "test-project",
        connectorId: "tiktok",
        owner: { type: "project" },
        slot: "social",
      })
    ).resolves.toMatchObject({ id: "conn_kept" })
  })

  test("refuses root connector-connection writes inside a transaction callback", async () => {
    // The real guard for `createConnectorConnectionOperationScope`. `ConnectorConnectionStorage`
    // exposes no methods of its own, only three sub-stores, so the generic facade has nothing to
    // wrap and every write would slip past the transaction lock and land outside it — silently.
    // To reproduce: swap that call in `storage/in-memory/index.ts` for `createOperationScopedFacade`
    // and this test fails while every other test in the suite still passes.
    const storage = new InMemoryStorage()

    await expect(
      storage.transaction(async () => {
        await storage.connectorConnections.authorizations.create({
          id: "connauth_escaped",
          projectId: "test-project",
          connectorId: "tiktok",
          authorizedBy: { type: "user", id: "u1" },
          scopes: ["video.list"],
          credentials: ENVELOPE,
          createdAt: AT,
        })
      })
    ).rejects.toThrow("Root storage cannot be used inside a transaction callback")

    await expect(
      storage.connectorConnections.authorizations.getById({
        projectId: "test-project",
        id: "connauth_escaped",
      })
    ).resolves.toBeNull()
  })
})
