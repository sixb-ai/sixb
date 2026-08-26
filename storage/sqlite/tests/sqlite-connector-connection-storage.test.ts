import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { runConnectorConnectionStorageContractSuite } from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { getSqliteStorageTestingAdapter } from "../src/testing"

runConnectorConnectionStorageContractSuite("SqliteConnectorConnectionStorage", {
  createStorage: () => new SqliteStorage(),
  advanceTime: (storage, durationMs) =>
    getSqliteStorageTestingAdapter(storage).advanceConnectorConnectionTime(durationMs),
  teardown: (storage) => storage.close(),
})

test("persists connector attempts, runs, authorizations and connections across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-connectors-"))
  let storage: SqliteStorage | undefined
  try {
    storage = new SqliteStorage({ path: directory })
    await migrateStorage(storage)
    const connections = storage.connectorConnections
    await connections.createConnectionRun({
      id: "run-a",
      projectId: "project-a",
      connectorId: "social",
      kind: "connect",
      owner: { type: "project" },
      slot: "default",
      initiatedByExecutionId: "execution-a",
      ttlMs: 60_000,
    })
    await connections.createAuthorizationAttempt({
      id: "attempt-a",
      projectId: "project-a",
      connectorId: "social",
      owner: { type: "project" },
      slot: "default",
      initiatedByExecutionId: "execution-a",
      stateHash: "state-hash",
      codeVerifier: sealedCredential(),
      redirectUri: "https://example.com/oauth/callback",
      connectionRunId: "run-a",
      returnTo: "https://app.example.com/connectors",
      callbackBindingHash: "binding-hash",
      ttlMs: 60_000,
    })
    const authorization = await connections.createAuthorization({
      id: "authorization-a",
      projectId: "project-a",
      connectorId: "social",
      authorizedBy: { type: "user", id: "user-a" },
      credentials: sealedCredential(),
      scopes: ["read"],
      accounts: [{ id: "account-a", label: "Account A" }],
      selectionTtlMs: 60_000,
    })
    await connections.putConnection({
      id: "connection-a",
      projectId: "project-a",
      connectorId: "social",
      authorizationId: authorization.id,
      owner: { type: "project" },
      slot: "default",
      account: { id: "account-a", label: "Account A" },
      replace: false,
    })
    storage.close()

    storage = new SqliteStorage({ path: directory })
    await expect(
      storage.connectorConnections.getConnectionRun({
        projectId: "project-a",
        connectorId: "social",
        runId: "run-a",
      })
    ).resolves.toMatchObject({ id: "run-a", status: "waiting" })
    await expect(
      storage.connectorConnections.consumeAuthorizationAttempt({
        id: "attempt-a",
        projectId: "project-a",
        connectorId: "social",
        stateHash: "state-hash",
        redirectUri: "https://example.com/oauth/callback",
      })
    ).resolves.toMatchObject({ id: "attempt-a" })
    await expect(
      storage.connectorConnections.getAuthorization({
        projectId: "project-a",
        connectorId: "social",
        authorizationId: "authorization-a",
      })
    ).resolves.toMatchObject({ id: "authorization-a", status: "active" })
    await expect(
      storage.connectorConnections.getConnectionById({
        projectId: "project-a",
        connectorId: "social",
        connectionId: "connection-a",
      })
    ).resolves.toMatchObject({ id: "connection-a", account: { id: "account-a" } })
  } finally {
    storage?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

function sealedCredential() {
  return {
    version: 1 as const,
    algorithm: "A256GCM" as const,
    nonce: "nonce",
    ciphertext: "ciphertext",
    tag: "tag",
  }
}
