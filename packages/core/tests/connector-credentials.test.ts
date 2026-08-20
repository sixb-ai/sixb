import { describe, expect, test } from "bun:test"
import {
  type ConnectorCredentialContext,
  createAesGcmConnectorCredentialProtector,
  InMemoryStorage,
} from "../src"
import { InMemoryConnectorConnectionStorage } from "../src/storage/connector-connections"

const context: ConnectorCredentialContext = {
  projectId: "project",
  connectorId: "social",
  recordId: "authorization-a",
  purpose: "oauth-authorization",
}

describe("connector credential protection", () => {
  test("authenticates immutable context and supports decrypt-only rotation keys", async () => {
    const oldKey = new Uint8Array(32).fill(1)
    const newKey = new Uint8Array(32).fill(2)
    const oldProtector = createAesGcmConnectorCredentialProtector({
      activeKeyId: "old",
      keys: { old: oldKey },
    })
    const envelope = await oldProtector.seal(new TextEncoder().encode("secret"), context)

    await expect(
      oldProtector.open(envelope, { ...context, recordId: "authorization-b" })
    ).rejects.toThrow("authentication failed")
    await expect(oldProtector.open({ ...envelope, ciphertext: "*" }, context)).rejects.toThrow(
      "authentication failed"
    )

    const rotatedProtector = createAesGcmConnectorCredentialProtector({
      activeKeyId: "new",
      keys: { old: oldKey, new: newKey },
    })
    expect(new TextDecoder().decode(await rotatedProtector.open(envelope, context))).toBe("secret")
    expect((await rotatedProtector.seal(new Uint8Array([1]), context)).keyId).toBe("new")
  })

  test("includes connector state in in-memory transaction rollback", async () => {
    const storage = new InMemoryStorage()
    const protector = createAesGcmConnectorCredentialProtector({
      activeKeyId: "test",
      keys: { test: new Uint8Array(32).fill(3) },
    })
    const credentials = await protector.seal(new TextEncoder().encode("secret"), context)

    await expect(
      storage.transaction(async (tx) => {
        await tx.connectorConnections!.createAuthorization({
          id: context.recordId,
          projectId: context.projectId,
          connectorId: context.connectorId,
          authorizedBy: { type: "user", id: "user-a" },
          credentials,
          scopes: [],
          accounts: [],
          createdAt: new Date("2026-08-19T12:00:00.000Z"),
        })
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")

    expect(await storage.connectorConnections.getAuthorization(context.recordId)).toBeNull()
  })
})

describe("connector connection storage", () => {
  test("only persists canonical accounts exposed by the authorization", async () => {
    const storage = new InMemoryStorage().connectorConnections
    const protector = createAesGcmConnectorCredentialProtector({
      activeKeyId: "test",
      keys: { test: new Uint8Array(32).fill(4) },
    })
    const credentials = await protector.seal(new TextEncoder().encode("secret"), context)
    await storage.createAuthorization({
      id: context.recordId,
      projectId: context.projectId,
      connectorId: context.connectorId,
      authorizedBy: { type: "user", id: "user-a" },
      credentials,
      scopes: [],
      accounts: [{ id: "account-a", label: "Canonical account" }],
      createdAt: new Date("2026-08-19T12:00:00.000Z"),
    })

    await expect(
      storage.putConnection({
        id: "connection-invalid",
        projectId: context.projectId,
        connectorId: context.connectorId,
        authorizationId: context.recordId,
        owner: { type: "project" },
        slot: "social",
        account: { id: "account-b", label: "Injected account" },
        replace: false,
        now: new Date("2026-08-19T12:01:00.000Z"),
      })
    ).rejects.toThrow("not exposed by its authorization")

    const result = await storage.putConnection({
      id: "connection-a",
      projectId: context.projectId,
      connectorId: context.connectorId,
      authorizationId: context.recordId,
      owner: { type: "project" },
      slot: "social",
      account: { id: "account-a", label: "Caller-controlled label" },
      replace: false,
      now: new Date("2026-08-19T12:01:00.000Z"),
    })
    expect(result.connection.account.label).toBe("Canonical account")
  })

  test("uses the storage clock to expire refresh leases", async () => {
    let now = new Date("2026-08-19T12:00:00.000Z")
    const storage = new InMemoryConnectorConnectionStorage({ now: () => new Date(now) })
    const protector = createAesGcmConnectorCredentialProtector({
      activeKeyId: "test",
      keys: { test: new Uint8Array(32).fill(5) },
    })
    const credentials = await protector.seal(new TextEncoder().encode("secret"), context)
    await storage.createAuthorization({
      id: context.recordId,
      projectId: context.projectId,
      connectorId: context.connectorId,
      authorizedBy: { type: "user", id: "user-a" },
      credentials,
      scopes: [],
      accounts: [],
      createdAt: now,
    })

    const first = await storage.claimRefreshLease({
      authorizationId: context.recordId,
      expectedRevision: 0,
      lease: { id: "lease-a", holderId: "worker-a" },
      durationMs: 1_000,
    })
    expect(first?.refreshLease?.expiresAt).toEqual(new Date("2026-08-19T12:00:01.000Z"))

    now = new Date("2026-08-19T12:00:00.999Z")
    expect(
      await storage.claimRefreshLease({
        authorizationId: context.recordId,
        expectedRevision: 0,
        lease: { id: "lease-b", holderId: "worker-b" },
        durationMs: 1_000,
      })
    ).toBeNull()

    now = new Date("2026-08-19T12:00:01.000Z")
    expect(
      (
        await storage.claimRefreshLease({
          authorizationId: context.recordId,
          expectedRevision: 0,
          lease: { id: "lease-b", holderId: "worker-b" },
          durationMs: 1_000,
        })
      )?.refreshLease?.id
    ).toBe("lease-b")
  })
})
