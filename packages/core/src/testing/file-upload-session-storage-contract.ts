import { describe, expect, test } from "bun:test"
import type { Principal } from "../auth"
import type { BlobUploadSession, FileRef, SignedBlobUploadPart } from "../blob-storage"
import {
  type CreateFileUploadSessionInput,
  DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS,
  type FileUploadSessionStore,
} from "../storage/file-upload-sessions"

export interface FileUploadSessionStorageContractSuiteOptions<
  TStorage extends FileUploadSessionStore = FileUploadSessionStore,
> {
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
}

const HOUR_MS = 60 * 60 * 1000
const projectId = "file-upload-contract"
const principal: Principal = { type: "user", id: "usr_contract" }
const fileRef: FileRef = {
  blobId: `blob_${"a".repeat(64)}`,
  digest: `sha256:${"a".repeat(64)}`,
  sizeBytes: 3,
  fileName: "report.pdf",
}

/**
 * Provider-neutral lifecycle, retention, and abandoned-upload contract for file upload
 * sessions. Stores read their own clock, so fixtures place `expiresAt` relative to the
 * real time instead of controlling it.
 */
export function runFileUploadSessionStorageContractSuite<TStorage extends FileUploadSessionStore>(
  label: string,
  options: FileUploadSessionStorageContractSuiteOptions<TStorage>
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
    test("round-trips every field, including provider fields it does not know", async () => {
      await withStorage(async (storage) => {
        // A blob provider may extend its session shape; the store must not drop the extra field.
        const providerUpload = { ...multipart("upload_roundtrip"), partReceipt: "etag" }
        const input = sessionInput("upload_roundtrip", {
          fileName: "report.pdf",
          mediaType: "application/pdf",
          logicalPath: "reports/q3.pdf",
          expectedSizeBytes: 3,
          expectedDigest: fileRef.digest,
          providerUpload,
        })
        const created = await storage.create(input)

        expect(created).toMatchObject({ status: "pending", principalKey: "user:usr_contract" })
        const read = await storage.getForPrincipal("upload_roundtrip", principal)
        expect(read).toEqual(created)
        expect(read.providerUpload?.expiresAt).toBeInstanceOf(Date)
        expect(read.providerUpload).toMatchObject({ partReceipt: "etag" })
      })
    })

    test("hides a session from other principals and unknown ids", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput("upload_private"))

        await expect(
          storage.getForPrincipal("upload_private", { type: "user", id: "usr_other" })
        ).rejects.toMatchObject({ reason: "not_found" })
        await expect(storage.getForPrincipal("upload_missing", principal)).rejects.toMatchObject({
          reason: "not_found",
        })
      })
    })

    test("rejects a duplicate id", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput("upload_duplicate"))
        await expect(storage.create(sessionInput("upload_duplicate"))).rejects.toThrow(
          "already exists"
        )
      })
    })

    test("keeps signed parts unique and ordered by part number", async () => {
      await withStorage(async (storage) => {
        await storage.create(
          sessionInput("upload_parts", { providerUpload: multipart("upload_parts") })
        )
        // Insertion order differs from sorted order at every step, so dropping the sort fails.
        await storage.addSignedPart("upload_parts", signedPart(3))
        await storage.addSignedPart("upload_parts", signedPart(1))
        await storage.addSignedPart("upload_parts", signedPart(2))
        const updated = await storage.addSignedPart("upload_parts", signedPart(2, "replaced"))

        expect(updated.signedParts.map((part) => [part.partNumber, part.url])).toEqual([
          [1, "https://blob.test/part-1"],
          [2, "https://blob.test/part-2-replaced"],
          [3, "https://blob.test/part-3"],
        ])
        const read = await storage.getForPrincipal("upload_parts", principal)
        expect(read.signedParts).toEqual(updated.signedParts)
        expect(read.signedParts[0]?.expiresAt).toBeInstanceOf(Date)
      })
    })

    test("does not lose a part signed concurrently with another", async () => {
      await withStorage(async (storage) => {
        await storage.create(
          sessionInput("upload_race", { providerUpload: multipart("upload_race") })
        )
        await Promise.all(
          [1, 2, 3, 4, 5].map((n) => storage.addSignedPart("upload_race", signedPart(n)))
        )

        const read = await storage.getForPrincipal("upload_race", principal)
        expect(read.signedParts.map((part) => part.partNumber)).toEqual([1, 2, 3, 4, 5])
      })
    })

    test("moves through markUploaded to one terminal state", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput("upload_done"))
        const uploaded = await storage.markUploaded("upload_done", fileRef)
        expect(uploaded).toMatchObject({ status: "pending", fileRef })

        const completed = await storage.complete("upload_done", fileRef)
        expect(completed.status).toBe("completed")
        expect(completed.completedAt).toBeInstanceOf(Date)
        await expect(storage.complete("upload_done", fileRef)).rejects.toMatchObject({
          reason: "already_completed",
        })
        await expect(storage.abort("upload_done")).rejects.toMatchObject({
          reason: "already_completed",
        })

        await storage.create(sessionInput("upload_cancelled"))
        expect((await storage.abort("upload_cancelled")).status).toBe("aborted")
        await expect(storage.abort("upload_cancelled")).rejects.toMatchObject({
          reason: "already_aborted",
        })
      })
    })

    test("checks expiry at the gate only, so a request that passed it can finish", async () => {
      await withStorage(async (storage) => {
        // Provider uploads keep both rows unreapable while pending.
        for (const id of ["upload_late", "upload_abort_late"]) {
          await storage.create(
            sessionInput(id, { expiresAt: ago(HOUR_MS), providerUpload: multipart(id) })
          )
        }

        await expect(storage.getForPrincipal("upload_late", principal)).rejects.toMatchObject({
          reason: "expired",
        })
        // Transitions run after slow blob I/O that began before `expiresAt`.
        await storage.addSignedPart("upload_late", signedPart(1))
        await storage.markUploaded("upload_late", fileRef)
        expect((await storage.complete("upload_late", fileRef)).status).toBe("completed")
        expect((await storage.abort("upload_abort_late")).status).toBe("aborted")
      })
    })

    test("lists abandoned sessions for one project only", async () => {
      await withStorage(async (storage) => {
        await storage.create(
          sessionInput("upload_ours", {
            expiresAt: ago(HOUR_MS),
            providerUpload: multipart("ours"),
          })
        )
        await storage.create(
          sessionInput("upload_theirs", {
            projectId: "other-project",
            expiresAt: ago(HOUR_MS),
            providerUpload: multipart("theirs"),
          })
        )

        const ids = (await storage.listAbandoned({ projectId, now: new Date(), limit: 10 })).map(
          (session) => session.id
        )
        expect(ids).toEqual(["upload_ours"])
      })
    })

    test("never deletes an abandoned session, on read or on cleanup", async () => {
      await withStorage(async (storage) => {
        await storage.create(
          sessionInput("upload_abandoned", {
            expiresAt: ago(HOUR_MS),
            providerUpload: multipart("upload_abandoned"),
          })
        )

        // Reading an expired session must not delete it: nothing would abort its provider upload.
        await expect(storage.getForPrincipal("upload_abandoned", principal)).rejects.toMatchObject({
          reason: "expired",
        })
        expect(await storage.cleanupExpired(later(HOUR_MS))).toBe(0)
        expect(
          (await storage.listAbandoned({ projectId, now: new Date(), limit: 10 })).map(
            (session) => session.id
          )
        ).toEqual(["upload_abandoned"])
      })
    })

    test("lists only abandoned sessions, oldest expiry first, within the limit", async () => {
      await withStorage(async (storage) => {
        await storage.create(
          sessionInput("upload_newer", { expiresAt: ago(HOUR_MS), providerUpload: multipart("n") })
        )
        await storage.create(
          sessionInput("upload_older", {
            expiresAt: ago(2 * HOUR_MS),
            providerUpload: multipart("o"),
          })
        )
        await storage.create(sessionInput("upload_live", { providerUpload: multipart("live") }))
        await storage.create(sessionInput("upload_server", { expiresAt: ago(HOUR_MS) }))
        await storage.create(
          sessionInput("upload_aborted", {
            expiresAt: ago(HOUR_MS),
            providerUpload: multipart("a"),
          })
        )
        await storage.abort("upload_aborted")

        const ids = async (limit: number) =>
          (await storage.listAbandoned({ projectId, now: new Date(), limit })).map(
            (session) => session.id
          )
        expect(await ids(10)).toEqual(["upload_older", "upload_newer"])
        expect(await ids(1)).toEqual(["upload_older"])
        const [oldest] = await storage.listAbandoned({ projectId, now: new Date(), limit: 1 })
        expect(oldest?.providerUpload?.expiresAt).toBeInstanceOf(Date)
        await expect(
          storage.listAbandoned({ projectId, now: new Date(), limit: 0 })
        ).rejects.toThrow("positive integer")
      })
    })

    test("reaps expired sessions without a provider upload and terminal ones after their TTL", async () => {
      await withStorage(async (storage) => {
        await storage.create(sessionInput("upload_live"))
        await storage.create(sessionInput("upload_finished"))
        await storage.complete("upload_finished", fileRef)
        // Created last: a store may reap opportunistically on `create`.
        await storage.create(sessionInput("upload_expired", { expiresAt: ago(HOUR_MS) }))

        expect(await storage.cleanupExpired(new Date())).toBe(1)
        await expect(storage.getForPrincipal("upload_expired", principal)).rejects.toMatchObject({
          reason: "not_found",
        })
        // A completed session outlives its expiry so a retried `complete` stays idempotent.
        expect((await storage.getForPrincipal("upload_finished", principal)).status).toBe(
          "completed"
        )

        expect(
          await storage.cleanupExpired(later(DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS + 60_000))
        ).toBe(1)
        await expect(storage.getForPrincipal("upload_finished", principal)).rejects.toMatchObject({
          reason: "not_found",
        })
        expect((await storage.getForPrincipal("upload_live", principal)).status).toBe("pending")
      })
    })

    test("reaps an abandoned session once it has been aborted", async () => {
      await withStorage(async (storage) => {
        await storage.create(
          sessionInput("upload_swept", { expiresAt: ago(HOUR_MS), providerUpload: multipart("s") })
        )
        await storage.abort("upload_swept")

        expect(await storage.listAbandoned({ projectId, now: new Date(), limit: 10 })).toEqual([])
        expect(await storage.cleanupExpired(new Date())).toBe(0)
        expect(
          await storage.cleanupExpired(later(DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS + 60_000))
        ).toBe(1)
      })
    })
  })
}

function sessionInput(
  id: string,
  overrides: Partial<CreateFileUploadSessionInput> = {}
): CreateFileUploadSessionInput {
  return {
    id,
    projectId,
    principal,
    strategy: overrides.providerUpload?.strategy ?? "server",
    expiresAt: later(HOUR_MS),
    ...overrides,
  }
}

function multipart(uploadId: string): BlobUploadSession {
  return {
    strategy: "multipart",
    uploadId,
    partSizeBytes: 5 * 1024 * 1024,
    expiresAt: later(HOUR_MS),
    stagingKey: `staging/${uploadId}`,
    providerUploadId: `provider-${uploadId}`,
  }
}

function signedPart(partNumber: number, suffix?: string): SignedBlobUploadPart {
  return {
    partNumber,
    method: "PUT",
    url: `https://blob.test/part-${partNumber}${suffix ? `-${suffix}` : ""}`,
    headers: {},
    expiresAt: later(HOUR_MS),
  }
}

function ago(ms: number): Date {
  return new Date(Date.now() - ms)
}

function later(ms: number): Date {
  return new Date(Date.now() + ms)
}
