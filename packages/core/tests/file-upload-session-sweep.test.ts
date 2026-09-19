import { describe, expect, test } from "bun:test"
import { InMemoryBroker, InMemoryStorage } from "../src"
import {
  type AbortBlobUploadInput,
  type BlobStorage,
  type BlobUploadSession,
  InMemoryBlobStorage,
} from "../src/blob-storage"
import { DomainEventService, OntologyOutboxDispatcher } from "../src/events"
import { OntologyMaintenance } from "../src/maintenance"
import { DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS } from "../src/storage"

const MINUTE_MS = 60_000
const principal = { type: "user", id: "usr_sweep" } as const

describe("OntologyMaintenance abandoned upload sweep", () => {
  test("aborts the provider upload, retires the session, then reaps it", async () => {
    const blobs = new DirectUploadBlobStorage()
    const { storage, maintenance } = setup(blobs)
    await abandoned(storage, "upload_abandoned", 5 * MINUTE_MS)
    await storage.fileUploadSessions.create({
      id: "upload_live",
      projectId: "project",
      principal,
      strategy: "multipart",
      expiresAt: new Date(Date.now() + 60 * MINUTE_MS),
      providerUpload: providerUpload("upload_live"),
    })

    await maintenance.runNow()

    expect(blobs.aborted).toEqual([
      {
        uploadId: "upload_abandoned",
        stagingKey: "staging/upload_abandoned",
        providerUploadId: "provider-upload_abandoned",
      },
    ])
    expect(await storage.fileUploadSessions.listAbandoned(new Date(), 10)).toEqual([])
    expect(maintenance.getSnapshot().lastError).toBeNull()
    // Aborted, not deleted: it stays until the terminal TTL, like any retired session.
    expect(await storage.fileUploadSessions.cleanupExpired(new Date())).toBe(0)
    expect(
      await storage.fileUploadSessions.cleanupExpired(
        new Date(Date.now() + DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS + MINUTE_MS)
      )
    ).toBe(1)
  })

  test("keeps a session whose provider abort fails within the grace period", async () => {
    const blobs = new DirectUploadBlobStorage({ fail: true })
    const { storage, maintenance } = setup(blobs)
    await abandoned(storage, "upload_retry", MINUTE_MS)

    await maintenance.runNow()

    // Still pending and still listed, so the next pass retries the abort.
    expect(
      (await storage.fileUploadSessions.listAbandoned(new Date(), 10)).map((s) => s.id)
    ).toEqual(["upload_retry"])
    expect(maintenance.getSnapshot().lastError).toContain("provider abort failed")
  })

  test("retires a session whose provider abort keeps failing past the grace period", async () => {
    const blobs = new DirectUploadBlobStorage({ fail: true })
    const { storage, maintenance } = setup(blobs)
    await abandoned(storage, "upload_given_up", 60 * MINUTE_MS)

    await maintenance.runNow()

    expect(blobs.attempts).toBe(1)
    expect(await storage.fileUploadSessions.listAbandoned(new Date(), 10)).toEqual([])
    // Giving up is still reported: the parts now depend on the bucket lifecycle rule.
    expect(maintenance.getSnapshot().lastError).toContain("provider abort failed")
  })

  test("retires sessions directly when blob storage cannot abort uploads", async () => {
    const { storage, maintenance } = setup(new InMemoryBlobStorage())
    await abandoned(storage, "upload_no_provider", 5 * MINUTE_MS)

    await maintenance.runNow()

    expect(await storage.fileUploadSessions.listAbandoned(new Date(), 10)).toEqual([])
    expect(maintenance.getSnapshot().lastError).toBeNull()
  })

  test("treats a session another instance retired first as done", async () => {
    const blobs = new DirectUploadBlobStorage()
    const { storage, maintenance } = setup(blobs)
    await abandoned(storage, "upload_raced", 5 * MINUTE_MS)
    // Another API instance's pass retires the row while ours is aborting the provider upload.
    blobs.onAbort = () => storage.fileUploadSessions.abort("upload_raced")

    await maintenance.runNow()

    expect(blobs.aborted).toHaveLength(1)
    expect(maintenance.getSnapshot().lastError).toBeNull()
  })

  test("retires at most cleanupLimit sessions per pass, oldest expiry first", async () => {
    const blobs = new DirectUploadBlobStorage()
    const { storage, maintenance } = setup(blobs, { cleanupLimit: 1 })
    await abandoned(storage, "upload_newer", 5 * MINUTE_MS)
    await abandoned(storage, "upload_older", 10 * MINUTE_MS)

    await maintenance.runNow()

    expect(blobs.aborted.map((input) => input.uploadId)).toEqual(["upload_older"])
    expect(
      (await storage.fileUploadSessions.listAbandoned(new Date(), 10)).map((s) => s.id)
    ).toEqual(["upload_newer"])
  })
})

function setup(blobStorage: BlobStorage, options: { readonly cleanupLimit?: number } = {}) {
  const storage = new InMemoryStorage()
  const events = new DomainEventService({ projectId: "project", broker: new InMemoryBroker() })
  const maintenance = new OntologyMaintenance({
    projectId: "project",
    storage,
    dispatcher: new OntologyOutboxDispatcher({ projectId: "project", storage, events }),
    blobStorage,
    options: { intervalMs: 60_000, ...options },
    onError: () => {},
  })
  return { storage, maintenance }
}

async function abandoned(storage: InMemoryStorage, id: string, expiredForMs: number) {
  await storage.fileUploadSessions.create({
    id,
    projectId: "project",
    principal,
    strategy: "multipart",
    expiresAt: new Date(Date.now() - expiredForMs),
    providerUpload: providerUpload(id),
  })
}

function providerUpload(id: string): BlobUploadSession {
  return {
    strategy: "multipart",
    uploadId: id,
    partSizeBytes: 5 * 1024 * 1024,
    expiresAt: new Date(Date.now() + 60 * MINUTE_MS),
    stagingKey: `staging/${id}`,
    providerUploadId: `provider-${id}`,
  }
}

class DirectUploadBlobStorage extends InMemoryBlobStorage {
  readonly aborted: AbortBlobUploadInput[] = []
  attempts = 0
  onAbort: (() => Promise<unknown>) | undefined

  constructor(private readonly options: { readonly fail?: boolean } = {}) {
    super()
  }

  async createUpload(): Promise<never> {
    throw new Error("unused")
  }

  async signUploadPart(): Promise<never> {
    throw new Error("unused")
  }

  async completeUpload(): Promise<never> {
    throw new Error("unused")
  }

  async abortUpload(input: AbortBlobUploadInput): Promise<void> {
    this.attempts += 1
    if (this.options.fail) throw new Error("provider abort failed")
    await this.onAbort?.()
    this.aborted.push(input)
  }
}
