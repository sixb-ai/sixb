import { describe, expect, test } from "bun:test"
import type {
  ConnectorAuthorizationRecord,
  ConnectorConnectionStorage,
} from "../storage/connector-connections"

export interface ConnectorConnectionStorageContractSuiteOptions<
  TStorage extends ConnectorConnectionStorage = ConnectorConnectionStorage,
> {
  /** Factory that produces a fresh connector connection storage for each test case. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  /** Optional cleanup invoked after every test case. */
  readonly teardown?: (storage: TStorage) => void | Promise<void>
}

const projectId = "project-a"
const connectorId = "social"
const credentials = {
  version: 1,
  algorithm: "A256GCM",
  nonce: "nonce",
  ciphertext: "ciphertext",
  tag: "tag",
} as const

/** Runs the atomicity, fencing, slot uniqueness and project-isolation storage contract. */
export function runConnectorConnectionStorageContractSuite<
  TStorage extends ConnectorConnectionStorage,
>(label: string, options: ConnectorConnectionStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await body(storage)
    } finally {
      await options.teardown?.(storage)
    }
  }

  describe(label, () => {
    test("keeps one stable connection per project connector slot", async () => {
      await withStorage(async (storage) => {
        const first = await createAuthorization(storage, "authorization-a", "account-a")
        const firstConnection = await connect(storage, first, "connection-a", "account-a")
        const second = await createAuthorization(storage, "authorization-b", "account-b")

        await expect(connect(storage, second, "connection-b", "account-b")).rejects.toThrow(
          "explicit replacement is required"
        )
        const replaced = await storage.putConnection({
          id: "connection-b",
          projectId,
          connectorId,
          authorizationId: second.id,
          owner: { type: "project" },
          slot: "default",
          account: { id: "account-b", label: "ignored" },
          replace: true,
        })
        expect(replaced.connection.id).toBe(firstConnection.connection.id)
        expect(
          await storage.getConnection({
            projectId,
            connectorId,
            owner: { type: "project" },
            slot: "default",
          })
        ).toMatchObject({ authorizationId: second.id, account: { id: "account-b" } })
      })
    })

    test("keeps pending selection untouched when connection validation fails", async () => {
      await withStorage(async (storage) => {
        const active = await createAuthorization(storage, "authorization-a", "account-a")
        const existing = await connect(storage, active, "connection-a", "account-a")
        const replacement = await createAuthorization(storage, "authorization-b", "account-b")

        await expect(connect(storage, replacement, "connection-b", "account-b")).rejects.toThrow(
          "explicit replacement is required"
        )
        expect(await storage.getAuthorization(replacement.id)).toEqual(replacement)

        const duplicateId = await createAuthorization(storage, "authorization-c", "account-c")
        await expect(
          storage.putConnection({
            id: existing.connection.id,
            projectId,
            connectorId,
            authorizationId: duplicateId.id,
            owner: { type: "project" },
            slot: "secondary",
            account: { id: "account-c", label: "ignored" },
            replace: false,
          })
        ).rejects.toThrow("connection id already exists")
        expect(await storage.getAuthorization(duplicateId.id)).toEqual(duplicateId)
      })
    })

    test("fences staged credentials by project, revision and mutation id", async () => {
      await withStorage(async (storage) => {
        const authorization = await createActiveAuthorization(storage)
        await expect(
          storage.claimCredentialMutation({
            projectId: "project-b",
            connectorId,
            authorizationId: authorization.id,
            expectedRevision: authorization.revision,
            mutation: { id: "mutation-a", kind: "refresh", holderId: "worker-a" },
            leaseDurationMs: 30_000,
            operationTimeoutMs: 60_000,
          })
        ).resolves.toBeNull()

        const claim = await storage.claimCredentialMutation({
          projectId,
          connectorId,
          authorizationId: authorization.id,
          expectedRevision: authorization.revision,
          mutation: { id: "mutation-a", kind: "refresh", holderId: "worker-a" },
          leaseDurationMs: 30_000,
          operationTimeoutMs: 60_000,
        })
        expect(claim).not.toBeNull()
        const claimed = claim!.authorization
        const executing = await storage.markCredentialMutationExecuting({
          ...fence(claimed),
          holderId: "worker-a",
        })
        expect(executing?.credentialMutation?.phase).toBe("executing")
        await expect(
          storage.stageCredentialMutationCredentials({
            ...fence(claimed),
            mutationId: "stale-mutation",
            holderId: "worker-a",
            credentials,
            scopes: [],
          })
        ).resolves.toBeNull()

        const staged = await storage.stageCredentialMutationCredentials({
          ...fence(claimed),
          holderId: "worker-a",
          credentials,
          scopes: [],
        })
        expect(staged?.credentialMutation?.phase).toBe("result_staged")
        await expect(
          storage.finalizeRefresh({ ...fence(claimed), expectedRevision: claimed.revision + 1 })
        ).resolves.toBeNull()
        await expect(storage.finalizeRefresh(fence(claimed))).resolves.toMatchObject({
          revision: claimed.revision + 1,
          credentialMutation: undefined,
        })
      })
    })

    test("disconnects every local usage atomically when revocation starts", async () => {
      await withStorage(async (storage) => {
        const authorization = await createAuthorization(storage, "authorization-a", "account-a")
        const first = await connect(storage, authorization, "connection-a", "account-a")
        await storage.putConnection({
          id: "connection-b",
          projectId,
          connectorId,
          authorizationId: authorization.id,
          owner: { type: "project" },
          slot: "secondary",
          account: { id: "account-a", label: "ignored" },
          replace: false,
        })
        const active = (await storage.getAuthorization(authorization.id))!
        const claim = await storage.claimCredentialMutation({
          projectId,
          connectorId,
          authorizationId: authorization.id,
          expectedRevision: active.revision,
          mutation: { id: "mutation-revoke", kind: "revocation", holderId: "worker-a" },
          leaseDurationMs: 30_000,
          operationTimeoutMs: 60_000,
        })

        expect(claim?.authorization.status).toBe("revocation_pending")
        expect(claim?.disconnected.map((connection) => connection.id).sort()).toEqual(
          [first.connection.id, "connection-b"].sort()
        )
        expect(await storage.listConnectionsByAuthorization(authorization.id)).toEqual([])
      })
    })

    test("freezes the attached connection set during reauthorization", async () => {
      await withStorage(async (storage) => {
        const authorization = await createActiveAuthorization(storage)
        const connections = await storage.listConnectionsByAuthorization(authorization.id)
        const claim = await storage.claimCredentialMutation({
          projectId,
          connectorId,
          authorizationId: authorization.id,
          expectedRevision: authorization.revision,
          mutation: {
            id: "mutation-reauthorize",
            kind: "reauthorization",
            holderId: "worker-a",
          },
          expectedConnectionIds: connections.map((connection) => connection.id),
          leaseDurationMs: 30_000,
          operationTimeoutMs: 60_000,
        })
        expect(claim).not.toBeNull()

        await expect(
          storage.disconnectConnection({
            projectId,
            connectorId,
            connectionId: connections[0].id,
          })
        ).rejects.toThrow("being reauthorized")
      })
    })
  })
}

async function createAuthorization(
  storage: ConnectorConnectionStorage,
  id: string,
  accountId: string
): Promise<ConnectorAuthorizationRecord> {
  return storage.createAuthorization({
    id,
    projectId,
    connectorId,
    authorizedBy: { type: "user", id: "user-a" },
    credentials,
    scopes: [],
    accounts: [{ id: accountId, label: accountId }],
    selectionTtlMs: 60_000,
  })
}

async function createActiveAuthorization(
  storage: ConnectorConnectionStorage
): Promise<ConnectorAuthorizationRecord> {
  const authorization = await createAuthorization(storage, "authorization-a", "account-a")
  const result = await connect(storage, authorization, "connection-a", "account-a")
  return result.authorization
}

function connect(
  storage: ConnectorConnectionStorage,
  authorization: ConnectorAuthorizationRecord,
  connectionId: string,
  accountId: string
) {
  return storage.putConnection({
    id: connectionId,
    projectId,
    connectorId,
    authorizationId: authorization.id,
    owner: { type: "project" },
    slot: "default",
    account: { id: accountId, label: "ignored" },
    replace: false,
  })
}

function fence(authorization: ConnectorAuthorizationRecord) {
  return {
    projectId: authorization.projectId,
    connectorId: authorization.connectorId,
    authorizationId: authorization.id,
    expectedRevision: authorization.revision,
    mutationId: authorization.credentialMutation!.id,
  }
}
