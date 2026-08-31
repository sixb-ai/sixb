import { describe, expect, test } from "bun:test"
import { InMemoryStorage, type SixbErrorCode } from "../src"
import {
  type ConnectorCredentialContext,
  createConnectorCredentialProtectorFromKey,
} from "../src/connectors/credentials"
import { isSixbError } from "../src/errors/internal"
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Expected promise to reject.")
}

function expectSixbError(error: unknown, code: SixbErrorCode) {
  expect(isSixbError(error)).toBe(true)
  if (!isSixbError(error)) throw new Error("Expected a coded Sixb error.")
  expect(error.code).toBe(code)
  return error
}

describe("connector credential protection", () => {
  test("authenticates immutable context", async () => {
    const credentialProtector = protector(1)
    const envelope = await credentialProtector.seal(new TextEncoder().encode("secret"), context)

    expectSixbError(
      await rejectionOf(
        credentialProtector.open(envelope, { ...context, recordId: "authorization-b" })
      ),
      "connector.credentials_unavailable"
    )
    await expect(
      credentialProtector.open({ ...envelope, ciphertext: "*" }, context)
    ).rejects.toThrow("authentication failed")
    expect(new TextDecoder().decode(await credentialProtector.open(envelope, context))).toBe(
      "secret"
    )
  })

  test("requires one canonical base64url key containing exactly 32 bytes", () => {
    let error: unknown
    try {
      createConnectorCredentialProtectorFromKey("not+/base64")
    } catch (caught) {
      error = caught
    }
    expectSixbError(error, "connector.configuration_invalid")
    expect((error as Error).message).toContain("canonical base64url")
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
          selectionTtlMs: 60_000,
        })
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")

    expect(
      await storage.connectorConnections.getAuthorization({
        projectId: context.projectId,
        connectorId: context.connectorId,
        authorizationId: context.recordId,
      })
    ).toBeNull()
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
      selectionTtlMs: 60_000,
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
    })
    expect(result.connection.account.label).toBe("Canonical account")
  })

  test("uses the storage clock to expire credential mutation leases", async () => {
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
      accounts: [{ id: "account-a", label: "Account A" }],
      selectionTtlMs: 60_000,
    })
    await storage.putConnection({
      id: "connection-a",
      projectId: context.projectId,
      connectorId: context.connectorId,
      authorizationId: context.recordId,
      owner: { type: "project" },
      slot: "social",
      account: { id: "account-a", label: "Account A" },
      replace: false,
    })

    const first = await storage.claimCredentialMutation({
      projectId: context.projectId,
      connectorId: context.connectorId,
      authorizationId: context.recordId,
      expectedRevision: 1,
      mutation: { id: "mutation-a", kind: "refresh", holderId: "worker-a" },
      leaseDurationMs: 1_000,
      operationTimeoutMs: 10_000,
    })
    expect(first?.authorization.credentialMutation?.expiresAt).toEqual(
      new Date("2026-08-19T12:00:01.000Z")
    )

    now = new Date("2026-08-19T12:00:00.999Z")
    expect(
      await storage.claimCredentialMutation({
        projectId: context.projectId,
        connectorId: context.connectorId,
        authorizationId: context.recordId,
        expectedRevision: 1,
        mutation: { id: "mutation-b", kind: "refresh", holderId: "worker-b" },
        leaseDurationMs: 1_000,
        operationTimeoutMs: 10_000,
      })
    ).toBeNull()

    now = new Date("2026-08-19T12:00:01.000Z")
    expect(
      (
        await storage.claimCredentialMutation({
          projectId: context.projectId,
          connectorId: context.connectorId,
          authorizationId: context.recordId,
          expectedRevision: 1,
          mutation: { id: "mutation-b", kind: "refresh", holderId: "worker-b" },
          leaseDurationMs: 1_000,
          operationTimeoutMs: 10_000,
        })
      )?.authorization.credentialMutation?.id
    ).toBe("mutation-b")
  })
})
