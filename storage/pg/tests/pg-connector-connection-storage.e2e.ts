import { expect, test } from "bun:test"
import { runConnectorConnectionStorageContractSuite } from "@sixb/core/testing"
import { PostgresStorage } from "../src"
import { getPostgresStorageTestingAdapter } from "../src/testing"
import { createTestStorage } from "./helpers"

runConnectorConnectionStorageContractSuite("PgConnectorConnectionStorage", {
  createStorage: async () => (await createTestStorage()).storage,
  advanceTime: (storage, durationMs) =>
    getPostgresStorageTestingAdapter(storage).advanceConnectorConnectionTime(durationMs),
  teardown: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})

test("serializes callback, slot and credential claims across storage replicas", async () => {
  const { storage: first, schemaName } = await createTestStorage()
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("[SixbPg] DATABASE_URL is required.")
  const second = new PostgresStorage({ connectionString, schemaName, max: 2 })
  const projectId = "project-a"
  const connectorId = "social"
  const credentials = {
    version: 1,
    algorithm: "A256GCM",
    nonce: "nonce",
    ciphertext: "ciphertext",
    tag: "tag",
  } as const

  try {
    await first.connectorConnections.createConnectionRun({
      id: "run-a",
      projectId,
      connectorId,
      kind: "connect",
      owner: { type: "project" },
      slot: "callback",
      initiatedByExecutionId: "execution-a",
      ttlMs: 60_000,
    })
    await first.connectorConnections.createAuthorizationAttempt({
      id: "attempt-a",
      projectId,
      connectorId,
      owner: { type: "project" },
      slot: "callback",
      initiatedByExecutionId: "execution-a",
      stateHash: "state-hash",
      codeVerifier: credentials,
      redirectUri: "https://example.com/oauth/callback",
      connectionRunId: "run-a",
      returnTo: "https://app.example.com/connectors",
      callbackBindingHash: "binding-hash",
      ttlMs: 60_000,
    })
    const callbackInput = {
      projectId,
      attemptId: "attempt-a",
      stateHash: "state-hash",
      callbackBindingHash: "binding-hash",
      redirectUri: "https://example.com/oauth/callback",
      processingId: "processing-a",
      processingTtlMs: 60_000,
    }
    const callbacks = await Promise.all([
      first.connectorConnections.claimConnectionRunCallback(callbackInput),
      second.connectorConnections.claimConnectionRunCallback({
        ...callbackInput,
        processingId: "processing-b",
      }),
    ])
    expect(callbacks.filter((result) => result?.type === "claimed")).toHaveLength(1)
    expect(callbacks.filter((result) => result === null)).toHaveLength(1)

    const [firstAuthorization, secondAuthorization] = await Promise.all([
      first.connectorConnections.createAuthorization({
        id: "authorization-a",
        projectId,
        connectorId,
        authorizedBy: { type: "user", id: "user-a" },
        credentials,
        scopes: [],
        accounts: [{ id: "account-a", label: "Account A" }],
        selectionTtlMs: 60_000,
      }),
      second.connectorConnections.createAuthorization({
        id: "authorization-b",
        projectId,
        connectorId,
        authorizedBy: { type: "user", id: "user-b" },
        credentials,
        scopes: [],
        accounts: [{ id: "account-b", label: "Account B" }],
        selectionTtlMs: 60_000,
      }),
    ])

    const selections = await Promise.allSettled([
      first.connectorConnections.putConnection({
        id: "connection-a",
        projectId,
        connectorId,
        authorizationId: firstAuthorization.id,
        owner: { type: "project" },
        slot: "default",
        account: { id: "account-a", label: "ignored" },
        replace: false,
      }),
      second.connectorConnections.putConnection({
        id: "connection-b",
        projectId,
        connectorId,
        authorizationId: secondAuthorization.id,
        owner: { type: "project" },
        slot: "default",
        account: { id: "account-b", label: "ignored" },
        replace: false,
      }),
    ])

    expect(selections.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(selections.filter((result) => result.status === "rejected")).toHaveLength(1)
    const connection = await first.connectorConnections.getConnection({
      projectId,
      connectorId,
      owner: { type: "project" },
      slot: "default",
    })
    expect(connection).not.toBeNull()
    const authorization = await first.connectorConnections.getAuthorization({
      projectId,
      connectorId,
      authorizationId: connection!.authorizationId,
    })
    if (!authorization) throw new Error("Expected the winning authorization.")

    const claims = await Promise.all([
      first.connectorConnections.claimCredentialMutation({
        projectId,
        connectorId,
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        mutation: { id: "mutation-a", kind: "refresh", holderId: "worker-a" },
        leaseDurationMs: 30_000,
        operationTimeoutMs: 60_000,
      }),
      second.connectorConnections.claimCredentialMutation({
        projectId,
        connectorId,
        authorizationId: authorization.id,
        expectedRevision: authorization.revision,
        mutation: { id: "mutation-b", kind: "refresh", holderId: "worker-b" },
        leaseDurationMs: 30_000,
        operationTimeoutMs: 60_000,
      }),
    ])
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1)
  } finally {
    await first.dropSchema()
    await Promise.all([first.close(), second.close()])
  }
})
