import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "../src"
import {
  type ConnectorCredentialContext,
  createConnectorCredentialProtectorFromKey,
} from "../src/connectors/credentials"
import { InMemoryConnectorConnectionStorage } from "../src/storage/connector-connections"

const context: ConnectorCredentialContext = {
  projectId: "project",
  connectorId: "social",
  recordId: "authorization-a",
  purpose: "oauth-authorization",
}

function protector(fill: number) {
  const key = Buffer.from(new Uint8Array(32).fill(fill)).toString("base64url")
  return createConnectorCredentialProtectorFromKey(key)
}

describe("connector credential protection", () => {
  test("authenticates immutable context", async () => {
    const credentialProtector = protector(1)
    const envelope = await credentialProtector.seal(new TextEncoder().encode("secret"), context)

    await expect(
      credentialProtector.open(envelope, { ...context, recordId: "authorization-b" })
    ).rejects.toThrow("authentication failed")
    await expect(
      credentialProtector.open({ ...envelope, ciphertext: "*" }, context)
    ).rejects.toThrow("authentication failed")
    expect(new TextDecoder().decode(await credentialProtector.open(envelope, context))).toBe(
      "secret"
    )
  })

  test("requires one canonical base64url key containing exactly 32 bytes", () => {
    expect(() => createConnectorCredentialProtectorFromKey("not+/base64")).toThrow(
      "canonical base64url"
    )
    expect(() =>
      createConnectorCredentialProtectorFromKey(
        Buffer.from(new Uint8Array(31)).toString("base64url")
      )
    ).toThrow("exactly 32 random bytes")
  })

  test("includes connector state in in-memory transaction rollback", async () => {
    const storage = new InMemoryStorage()
    const credentialProtector = protector(3)
    const credentials = await credentialProtector.seal(new TextEncoder().encode("secret"), context)

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
    const credentialProtector = protector(4)
    const credentials = await credentialProtector.seal(new TextEncoder().encode("secret"), context)
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
    const credentialProtector = protector(5)
    const credentials = await credentialProtector.seal(new TextEncoder().encode("secret"), context)
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
