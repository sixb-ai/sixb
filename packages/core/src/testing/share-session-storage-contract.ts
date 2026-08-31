import { describe, expect, test } from "bun:test"
import type {
  CreateShareSessionInput,
  RenewShareSessionIfValidInput,
  ShareSessionStorage,
} from "../storage/share-sessions"

export interface ShareSessionStorageContractSuiteOptions<
  TStorage extends ShareSessionStorage = ShareSessionStorage,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const projectId = "share-session-contract"
const createdAt = new Date("2026-08-20T12:00:00.000Z")
const expiresAt = new Date("2026-08-20T12:05:00.000Z")
const absoluteExpiresAt = new Date("2026-08-20T12:20:00.000Z")

/** Provider-neutral lifecycle, monotonic-renewal, and isolation contract for Share sessions. */
export function runShareSessionStorageContractSuite<TStorage extends ShareSessionStorage>(
  label: string,
  options: ShareSessionStorageContractSuiteOptions<TStorage>
): void {
  const withStorage = async (run: (storage: TStorage) => Promise<void>): Promise<void> => {
    const storage = await options.createStorage()
    try {
      await run(storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    test("stores normalized records and returns defensive copies", async () => {
      await withStorage(async (storage) => {
        const input = sessionInput()
        const created = await storage.create(input)
        input.createdAt.setUTCFullYear(2040)
        input.expiresAt.setUTCFullYear(2040)
        input.absoluteExpiresAt.setUTCFullYear(2040)
        created.createdAt.setUTCFullYear(2041)

        await expect(storage.getById({ projectId, id: "shs_1" })).resolves.toEqual(sessionInput())
      })
    })

    test("scopes identity and token-hash uniqueness to one project", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        await storage.create(sessionInput({ projectId: "other-project" }))

        await expect(
          storage.create(sessionInput({ tokenHash: "b".repeat(64) }))
        ).rejects.toMatchObject({ code: "duplicate" })
        await expect(storage.create(sessionInput({ id: "shs_2" }))).rejects.toMatchObject({
          code: "duplicate",
        })
        await expect(
          storage.getById({ projectId: "other-project", id: "shs_1" })
        ).resolves.toMatchObject({ projectId: "other-project" })
      })
    })

    test("rejects a session whose Share grant does not exist", async () => {
      await withStorage(async (storage) => {
        await expect(storage.create(sessionInput({ grantId: "missing" }))).rejects.toMatchObject({
          code: "invalid_input",
        })
      })
    })

    test("authenticates exact session identity and active deadlines", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        const valid = renewalInput({ expiresAt: new Date("2026-08-20T12:10:00.000Z") })
        await expect(storage.renewIfValid(valid)).resolves.toMatchObject({
          id: "shs_1",
          expiresAt: new Date("2026-08-20T12:10:00.000Z"),
        })
        await expect(storage.renewIfValid({ ...valid, id: "missing" })).resolves.toBeNull()
        await expect(storage.renewIfValid({ ...valid, grantId: "shr_other" })).resolves.toBeNull()
        await expect(
          storage.renewIfValid({ ...valid, tokenHash: "b".repeat(64) })
        ).resolves.toBeNull()
        await expect(
          storage.renewIfValid({ ...valid, now: new Date("2026-08-20T11:59:59.999Z") })
        ).resolves.toBeNull()
      })
    })

    test("never shortens, resurrects, or exceeds the absolute deadline", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())

        await expect(
          storage.renewIfValid(renewalInput({ expiresAt: new Date("2026-08-20T12:04:00.000Z") }))
        ).resolves.toMatchObject({ expiresAt })
        await expect(
          storage.renewIfValid(renewalInput({ expiresAt: new Date("2026-08-20T13:00:00.000Z") }))
        ).resolves.toMatchObject({ expiresAt: absoluteExpiresAt })
        await expect(
          storage.renewIfValid(
            renewalInput({
              now: new Date(absoluteExpiresAt),
              expiresAt: new Date("2026-08-20T13:00:00.000Z"),
            })
          )
        ).resolves.toBeNull()
      })
    })

    test("treats the exact inactivity expiry as expired", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        await expect(
          storage.renewIfValid(
            renewalInput({
              now: new Date(expiresAt),
              expiresAt: new Date("2026-08-20T12:10:00.000Z"),
            })
          )
        ).resolves.toBeNull()
      })
    })

    test("keeps concurrent renewals monotonic", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        await Promise.all([
          storage.renewIfValid(renewalInput({ expiresAt: new Date("2026-08-20T12:09:00.000Z") })),
          storage.renewIfValid(renewalInput({ expiresAt: new Date("2026-08-20T12:14:00.000Z") })),
        ])
        await expect(storage.getById({ projectId, id: "shs_1" })).resolves.toMatchObject({
          expiresAt: new Date("2026-08-20T12:14:00.000Z"),
        })
      })
    })

    test("keeps the first concurrent revocation and blocks renewal", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        const left = {
          projectId,
          id: "shs_1",
          revokedAt: new Date("2026-08-20T12:02:00.000Z"),
        }
        const right = {
          projectId,
          id: "shs_1",
          revokedAt: new Date("2026-08-20T12:03:00.000Z"),
        }
        const [first, second] = await Promise.all([storage.revoke(left), storage.revoke(right)])
        expect(first).toEqual(second)
        await expect(storage.revoke(right)).resolves.toEqual(first)
        await expect(storage.renewIfValid(renewalInput())).resolves.toBeNull()
        await expect(storage.revoke({ ...left, id: "missing" })).resolves.toBeNull()
      })
    })

    test("rejects malformed inputs and impossible timestamps consistently", async () => {
      await withStorage(async (storage) => {
        const invalid: CreateShareSessionInput[] = [
          sessionInput({ id: "" }),
          sessionInput({ projectId: "" }),
          sessionInput({ grantId: "" }),
          sessionInput({ tokenHash: "not-a-hash" }),
          sessionInput({ createdAt: new Date("invalid") }),
          sessionInput({ expiresAt: new Date(createdAt) }),
          sessionInput({ absoluteExpiresAt: new Date(createdAt) }),
          sessionInput({ absoluteExpiresAt: new Date("2026-08-20T12:04:00.000Z") }),
        ]
        for (const input of invalid) {
          await expect(storage.create(input)).rejects.toMatchObject({ code: "invalid_input" })
        }
        await expect(storage.create(null as never)).rejects.toMatchObject({
          code: "invalid_input",
        })
        await expect(storage.getById(null as never)).rejects.toMatchObject({
          code: "invalid_input",
        })
        await expect(
          storage.renewIfValid(renewalInput({ expiresAt: new Date("2026-08-20T12:01:00.000Z") }))
        ).rejects.toMatchObject({ code: "invalid_input" })
      })
    })

    test("rejects revocation before creation without changing the session", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput())
        await expect(
          storage.revoke({
            projectId,
            id: "shs_1",
            revokedAt: new Date("2026-08-20T11:59:59.999Z"),
          })
        ).rejects.toMatchObject({ code: "invalid_input" })
        expect(await storage.getById({ projectId, id: "shs_1" })).not.toHaveProperty("revokedAt")
      })
    })
  })
}

export function createShareSessionStorageContractInput(
  overrides: Partial<CreateShareSessionInput> = {}
): CreateShareSessionInput {
  return sessionInput(overrides)
}

function sessionInput(overrides: Partial<CreateShareSessionInput> = {}): CreateShareSessionInput {
  return {
    id: "shs_1",
    projectId,
    grantId: "shr_1",
    tokenHash: "a".repeat(64),
    createdAt: new Date(createdAt),
    expiresAt: new Date(expiresAt),
    absoluteExpiresAt: new Date(absoluteExpiresAt),
    ...overrides,
  }
}

function renewalInput(
  overrides: Partial<RenewShareSessionIfValidInput> = {}
): RenewShareSessionIfValidInput {
  return {
    projectId,
    id: "shs_1",
    grantId: "shr_1",
    tokenHash: "a".repeat(64),
    now: new Date("2026-08-20T12:01:00.000Z"),
    expiresAt: new Date("2026-08-20T12:08:00.000Z"),
    ...overrides,
  }
}
