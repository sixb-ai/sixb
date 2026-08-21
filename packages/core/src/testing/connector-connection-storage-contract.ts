import { describe, expect, test } from "bun:test"
import type {
  ConnectorConnectionFailure,
  ConnectorConnectionOwner,
  ConnectorConnectionStorage,
  SealedEnvelope,
} from "../storage/connector-connections"

export interface ConnectorConnectionStorageContractSuiteOptions<
  TStorage extends ConnectorConnectionStorage = ConnectorConnectionStorage,
> {
  /** Factory that returns an isolated connector-connection store for each test. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly setup?: (storage: TStorage) => void | Promise<void>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const PROJECT = "contract-project"
const CONNECTOR = "tiktok"

const AT = {
  created: new Date("2026-06-01T12:00:00.000Z"),
  leased: new Date("2026-06-01T12:00:05.000Z"),
  leaseExpires: new Date("2026-06-01T12:00:35.000Z"),
  refreshed: new Date("2026-06-01T12:00:10.000Z"),
  expired: new Date("2026-06-01T12:01:00.000Z"),
} as const

/**
 * Envelope fixtures are literal values, never produced by `sealConnectorSecret`.
 *
 * Storage persists sealed material opaquely, so a provider re-running this suite needs no
 * encryption key — and a provider that quietly rewrote the bytes would fail the equality assertions
 * below.
 */
function envelope(ciphertext: string): SealedEnvelope {
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    keyId: "contract-key-id",
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext,
    tag: "BBBBBBBBBBBBBBBBBBBBBB==",
  }
}

const OWNERS = {
  project: { type: "project" },
  principal: { type: "principal", principal: { type: "user", id: "user-1" } },
  object: { type: "object", ref: { objectTypeId: "Client", primaryId: "client-1" } },
} as const satisfies Record<string, ConnectorConnectionOwner>

const TERMINAL_FAILURE = {
  code: "connector.authorization_invalid",
  message: "Connector authorization is no longer usable.",
  retryable: false,
  at: "2026-06-01T12:00:09.000Z",
  details: { connectorId: CONNECTOR },
} as const satisfies ConnectorConnectionFailure

const RETRYABLE_FAILURE = {
  code: "connector.refresh_failed",
  message: "Connector credential refresh failed.",
  retryable: true,
  at: "2026-06-01T12:00:09.000Z",
  details: { connectorId: CONNECTOR },
} as const satisfies ConnectorConnectionFailure

/** Runs the persistent connector-connection contract against a provider. */
export function runConnectorConnectionStorageContractSuite<
  TStorage extends ConnectorConnectionStorage,
>(label: string, options: ConnectorConnectionStorageContractSuiteOptions<TStorage>): void {
  const withStorage = async (body: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await options.setup?.(storage)
      await body(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  const attempt = (
    overrides: Partial<{ id: string; stateHash: string; expiresAt: Date }> = {}
  ) => ({
    id: overrides.id ?? "connattempt_1",
    projectId: PROJECT,
    connectorId: CONNECTOR,
    stateHash: overrides.stateHash ?? "state-hash-1",
    requestedBy: { type: "user", id: "user-1" } as const,
    owner: OWNERS.principal,
    slot: "social",
    redirectUri: "https://app.example.com/connectors/tiktok/callback",
    scopes: ["video.list"],
    codeVerifier: envelope("verifier"),
    createdAt: AT.created,
    expiresAt: overrides.expiresAt ?? new Date("2026-06-01T12:00:30.000Z"),
  })

  const authorization = (id = "connauth_1") => ({
    id,
    projectId: PROJECT,
    connectorId: CONNECTOR,
    authorizedBy: { type: "user", id: "user-1" } as const,
    scopes: ["video.list"],
    credentials: envelope("initial"),
    createdAt: AT.created,
  })

  const connection = (overrides: {
    id: string
    owner?: ConnectorConnectionOwner
    slot?: string
    authorizationId?: string
    externalAccountId?: string
    projectId?: string
  }) => ({
    id: overrides.id,
    projectId: overrides.projectId ?? PROJECT,
    connectorId: CONNECTOR,
    owner: overrides.owner ?? OWNERS.principal,
    slot: overrides.slot ?? "social",
    authorizationId: overrides.authorizationId ?? "connauth_1",
    externalAccountId: overrides.externalAccountId ?? "account-a",
    at: AT.created,
  })

  describe(label, () => {
    describe("authorization attempts", () => {
      test("consumes an attempt exactly once", async () => {
        await withStorage(async (storage) => {
          await storage.attempts.create(attempt())

          await expect(
            storage.attempts.consume({
              projectId: PROJECT,
              id: "connattempt_1",
              stateHash: "state-hash-1",
              consumedAt: AT.leased,
            })
          ).resolves.toMatchObject({ consumedAt: AT.leased })

          // A replayed callback must not be able to complete a second authorization.
          await expect(
            storage.attempts.consume({
              projectId: PROJECT,
              id: "connattempt_1",
              stateHash: "state-hash-1",
              consumedAt: AT.leased,
            })
          ).rejects.toMatchObject({ code: "connector.authorization_attempt_invalid" })
        })
      })

      test("refuses a mismatched state, an expired attempt, and an unknown id", async () => {
        await withStorage(async (storage) => {
          await storage.attempts.create(attempt())
          await storage.attempts.create(attempt({ id: "connattempt_2", stateHash: "state-hash-2" }))

          for (const params of [
            { id: "connattempt_1", stateHash: "wrong", consumedAt: AT.leased },
            { id: "connattempt_2", stateHash: "state-hash-2", consumedAt: AT.expired },
            { id: "connattempt_missing", stateHash: "state-hash-1", consumedAt: AT.leased },
          ]) {
            await expect(
              storage.attempts.consume({ projectId: PROJECT, ...params })
            ).rejects.toMatchObject({ code: "connector.authorization_attempt_invalid" })
          }
        })
      })

      test("keeps the sealed verifier byte-identical", async () => {
        await withStorage(async (storage) => {
          await storage.attempts.create(attempt())
          const consumed = await storage.attempts.consume({
            projectId: PROJECT,
            id: "connattempt_1",
            stateHash: "state-hash-1",
            consumedAt: AT.leased,
          })
          expect(consumed.codeVerifier).toEqual(envelope("verifier"))
        })
      })
    })

    describe("authorizations", () => {
      test("creates an active grant at revision 1 and reads it back unchanged", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())

          const stored = await storage.authorizations.getById({
            projectId: PROJECT,
            id: "connauth_1",
          })
          expect(stored).toMatchObject({ status: "active", revision: 1 })
          expect(stored?.credentials).toEqual(envelope("initial"))
        })
      })

      test("returns null for an unknown grant", async () => {
        await withStorage(async (storage) => {
          await expect(
            storage.authorizations.getById({ projectId: PROJECT, id: "connauth_missing" })
          ).resolves.toBeNull()
        })
      })

      test("grants the refresh slot to one holder until the lease expires", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())
          const lease = {
            projectId: PROJECT,
            id: "connauth_1",
            leaseExpiresAt: AT.leaseExpires,
          }

          await expect(
            storage.authorizations.acquireRefreshLease({
              ...lease,
              leaseOwner: "worker-a",
              now: AT.leased,
            })
          ).resolves.toMatchObject({ acquired: true })

          // A second worker must not refresh concurrently, but still needs the current record so it
          // can re-read credentials the winner may already have rotated.
          const contended = await storage.authorizations.acquireRefreshLease({
            ...lease,
            leaseOwner: "worker-b",
            now: AT.refreshed,
          })
          expect(contended.acquired).toBe(false)
          expect(contended.authorization.revision).toBe(1)

          // An abandoned lease must not wedge refresh forever.
          await expect(
            storage.authorizations.acquireRefreshLease({
              ...lease,
              leaseOwner: "worker-b",
              now: AT.expired,
            })
          ).resolves.toMatchObject({ acquired: true })
        })
      })

      test("commits rotated credentials, bumps the revision, and frees the lease", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())
          await storage.authorizations.acquireRefreshLease({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            leaseExpiresAt: AT.leaseExpires,
            now: AT.leased,
          })

          const committed = await storage.authorizations.commitRefresh({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            expectedRevision: 1,
            credentials: envelope("rotated"),
            refreshedAt: AT.refreshed,
          })

          expect(committed.revision).toBe(2)
          expect(committed.credentials).toEqual(envelope("rotated"))
          expect(committed.refreshLeaseOwner).toBeUndefined()
          expect(committed.refreshLeaseExpiresAt).toBeUndefined()
        })
      })

      test("refuses a stale commit and leaves the newer credentials intact", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())
          await storage.authorizations.acquireRefreshLease({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            leaseExpiresAt: AT.leaseExpires,
            now: AT.leased,
          })
          await storage.authorizations.commitRefresh({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            expectedRevision: 1,
            credentials: envelope("rotated"),
            refreshedAt: AT.refreshed,
          })

          // Overwriting a newer refresh token with an older one costs the user a reconnect, so a
          // lost compare-and-set has to fail loudly rather than report an ignorable outcome.
          await expect(
            storage.authorizations.commitRefresh({
              projectId: PROJECT,
              id: "connauth_1",
              leaseOwner: "worker-a",
              expectedRevision: 1,
              credentials: envelope("stale"),
              refreshedAt: AT.expired,
            })
          ).rejects.toMatchObject({ code: "connector.refresh_conflict" })

          const stored = await storage.authorizations.getById({
            projectId: PROJECT,
            id: "connauth_1",
          })
          expect(stored?.credentials).toEqual(envelope("rotated"))
          expect(stored?.revision).toBe(2)
        })
      })

      test("a retryable failure releases the lease but keeps the grant usable", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())
          await storage.authorizations.acquireRefreshLease({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            leaseExpiresAt: AT.leaseExpires,
            now: AT.leased,
          })

          const released = await storage.authorizations.releaseRefreshLease({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            failure: RETRYABLE_FAILURE,
            releasedAt: AT.refreshed,
          })

          expect(released.status).toBe("active")
          expect(released.failure).toMatchObject({ code: "connector.refresh_failed" })
          expect(released.refreshLeaseOwner).toBeUndefined()
        })
      })

      test("a terminal failure invalidates the grant and detaches the stored failure", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())
          await storage.authorizations.acquireRefreshLease({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            leaseExpiresAt: AT.leaseExpires,
            now: AT.leased,
          })

          const mutable: ConnectorConnectionFailure = {
            ...TERMINAL_FAILURE,
            details: { ...TERMINAL_FAILURE.details } as Record<string, string>,
          }
          const released = await storage.authorizations.releaseRefreshLease({
            projectId: PROJECT,
            id: "connauth_1",
            leaseOwner: "worker-a",
            failure: mutable,
            releasedAt: AT.refreshed,
          })
          expect(released.status).toBe("invalid")
          expect(released.terminalAt).toEqual(AT.refreshed)

          // A stored failure must be a snapshot: mutating the caller's object cannot reach the row.
          ;(mutable.details as Record<string, string>).connectorId = "mutated"
          const stored = await storage.authorizations.getById({
            projectId: PROJECT,
            id: "connauth_1",
          })
          expect(stored?.failure?.details).toMatchObject({ connectorId: CONNECTOR })
        })
      })

      test("revoking is terminal and idempotent", async () => {
        await withStorage(async (storage) => {
          await storage.authorizations.create(authorization())

          const revoked = await storage.authorizations.revoke({
            projectId: PROJECT,
            id: "connauth_1",
            revokedAt: AT.refreshed,
          })
          expect(revoked).toMatchObject({ status: "revoked", terminalAt: AT.refreshed })

          await expect(
            storage.authorizations.revoke({
              projectId: PROJECT,
              id: "connauth_1",
              revokedAt: AT.expired,
            })
          ).resolves.toMatchObject({ status: "revoked", terminalAt: AT.refreshed })
        })
      })
    })

    describe("connections", () => {
      test("reconnecting the same slot keeps the connection id and creation instant", async () => {
        await withStorage(async (storage) => {
          const created = await storage.connections.upsert(connection({ id: "conn_1" }))

          // An application holding this id must not have it change under a reauthorization.
          const reconnected = await storage.connections.upsert({
            ...connection({ id: "conn_ignored", authorizationId: "connauth_2" }),
            externalAccountLabel: "@studio",
            at: AT.refreshed,
          })

          expect(reconnected.id).toBe(created.id)
          expect(reconnected.createdAt).toEqual(created.createdAt)
          expect(reconnected.authorizationId).toBe("connauth_2")
          expect(reconnected.externalAccountLabel).toBe("@studio")
        })
      })

      test("distinguishes owners that share a slot name", async () => {
        await withStorage(async (storage) => {
          await storage.connections.upsert(
            connection({ id: "conn_project", owner: OWNERS.project })
          )
          await storage.connections.upsert(
            connection({ id: "conn_principal", owner: OWNERS.principal })
          )
          await storage.connections.upsert(connection({ id: "conn_object", owner: OWNERS.object }))

          for (const [id, owner] of [
            ["conn_project", OWNERS.project],
            ["conn_principal", OWNERS.principal],
            ["conn_object", OWNERS.object],
          ] as const) {
            await expect(
              storage.connections.getBySlot({
                projectId: PROJECT,
                connectorId: CONNECTOR,
                owner,
                slot: "social",
              })
            ).resolves.toMatchObject({ id })
          }
        })
      })

      test("a second slot is a second connection", async () => {
        await withStorage(async (storage) => {
          await storage.connections.upsert(connection({ id: "conn_social" }))
          await storage.connections.upsert(connection({ id: "conn_ads", slot: "ads" }))

          await expect(
            storage.connections.getBySlot({
              projectId: PROJECT,
              connectorId: CONNECTOR,
              owner: OWNERS.principal,
              slot: "ads",
            })
          ).resolves.toMatchObject({ id: "conn_ads" })
        })
      })

      test("lists every connection sharing one grant", async () => {
        await withStorage(async (storage) => {
          await storage.connections.upsert(connection({ id: "conn_a" }))
          await storage.connections.upsert(
            connection({ id: "conn_b", slot: "ads", externalAccountId: "account-b" })
          )
          await storage.connections.upsert(
            connection({ id: "conn_other", slot: "crm", authorizationId: "connauth_2" })
          )

          const shared = await storage.connections.listByAuthorization({
            projectId: PROJECT,
            authorizationId: "connauth_1",
          })
          expect(shared.map((record) => record.id).sort()).toEqual(["conn_a", "conn_b"])
        })
      })

      test("disconnecting one connection leaves the others alone", async () => {
        await withStorage(async (storage) => {
          await storage.connections.upsert(connection({ id: "conn_a" }))
          await storage.connections.upsert(connection({ id: "conn_b", slot: "ads" }))

          const disconnected = await storage.connections.disconnect({
            projectId: PROJECT,
            id: "conn_a",
            disconnectedAt: AT.refreshed,
          })
          expect(disconnected.disconnectedAt).toEqual(AT.refreshed)

          const untouched = await storage.connections.getBySlot({
            projectId: PROJECT,
            connectorId: CONNECTOR,
            owner: OWNERS.principal,
            slot: "ads",
          })
          expect(untouched?.id).toBe("conn_b")
          expect(untouched?.disconnectedAt).toBeUndefined()
        })
      })

      test("a disconnected slot is free for a new connection", async () => {
        await withStorage(async (storage) => {
          await storage.connections.upsert(connection({ id: "conn_a" }))
          await storage.connections.disconnect({
            projectId: PROJECT,
            id: "conn_a",
            disconnectedAt: AT.refreshed,
          })

          const replacement = await storage.connections.upsert({
            ...connection({ id: "conn_b", externalAccountId: "account-b" }),
            at: AT.expired,
          })
          expect(replacement.id).toBe("conn_b")
          expect(replacement.externalAccountId).toBe("account-b")
        })
      })

      test("keeps projects isolated", async () => {
        await withStorage(async (storage) => {
          await storage.connections.upsert(connection({ id: "conn_a" }))
          await storage.connections.upsert(
            connection({ id: "conn_other_project", projectId: "other-project" })
          )

          await expect(
            storage.connections.getBySlot({
              projectId: "other-project",
              connectorId: CONNECTOR,
              owner: OWNERS.principal,
              slot: "social",
            })
          ).resolves.toMatchObject({ id: "conn_other_project" })
        })
      })
    })
  })
}
