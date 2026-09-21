import { describe, expect, test } from "bun:test"
import type { FileRef, Principal } from "../src"
import { InMemoryFileUploadSessions, InMemoryStorage } from "../src"
import type { FileUploadSessionErrorReason } from "../src/storage"
import { DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS, FileUploadSessionError } from "../src/storage"

const principal: Principal = { type: "system", id: "system" }

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 12,
  fileName: "report.txt",
  mediaType: "text/plain",
}

function futureDate(ms: number): Date {
  return new Date(Date.now() + ms)
}

async function expectSessionError(
  promise: Promise<unknown>,
  expected: { readonly reason: FileUploadSessionErrorReason; readonly message: string }
) {
  try {
    await promise
    throw new Error("Expected FileUploadSessionError.")
  } catch (error) {
    expect(error).toBeInstanceOf(FileUploadSessionError)
    expect((error as FileUploadSessionError).reason).toBe(expected.reason)
    expect((error as Error).message).toBe(expected.message)
  }
}

describe("InMemoryFileUploadSessions", () => {
  test("cleans expired pending sessions and reports direct lookup as expired", async () => {
    const sessions = new InMemoryFileUploadSessions()
    const expired = await sessions.create({
      id: "upload_expired",
      projectId: "test-project",
      principal,
      strategy: "server",
      expiresAt: new Date(Date.now() - 1),
    })

    await expectSessionError(sessions.getForPrincipal(expired.id, principal), {
      reason: "expired",
      message: "File upload session has expired.",
    })

    const stale = await sessions.create({
      id: "upload_stale",
      projectId: "test-project",
      principal,
      strategy: "server",
      expiresAt: new Date("2026-06-30T00:00:00.000Z"),
    })
    const deleted = await sessions.cleanupExpired(new Date("2026-06-30T00:00:00.001Z"))

    expect(deleted).toBe(1)
    await expectSessionError(sessions.getForPrincipal(stale.id, principal), {
      reason: "not_found",
      message: "File upload session not found.",
    })
  })

  test("keeps completed sessions briefly, then cleans them after terminal TTL", async () => {
    const sessions = new InMemoryFileUploadSessions()
    const session = await sessions.create({
      id: "upload_completed",
      projectId: "test-project",
      principal,
      strategy: "server",
      expiresAt: futureDate(60_000),
    })

    const completed = await sessions.complete(session.id, fileRef)
    expect(completed.status).toBe("completed")
    expect(await sessions.getForPrincipal(session.id, principal)).toMatchObject({
      status: "completed",
      fileRef,
    })

    const deletedBeforeTtl = await sessions.cleanupExpired(
      new Date(completed.completedAt!.getTime() + DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS - 1)
    )
    expect(deletedBeforeTtl).toBe(0)

    const deletedAfterTtl = await sessions.cleanupExpired(
      new Date(completed.completedAt!.getTime() + DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS)
    )
    expect(deletedAfterTtl).toBe(1)
    await expectSessionError(sessions.getForPrincipal(session.id, principal), {
      reason: "not_found",
      message: "File upload session not found.",
    })
  })

  test("cleans aborted sessions after terminal TTL", async () => {
    const sessions = new InMemoryFileUploadSessions()
    const session = await sessions.create({
      id: "upload_aborted",
      projectId: "test-project",
      principal,
      strategy: "server",
      expiresAt: futureDate(60_000),
    })

    const aborted = await sessions.abort(session.id)
    expect(aborted.status).toBe("aborted")

    const deleted = await sessions.cleanupExpired(
      new Date(aborted.abortedAt!.getTime() + DEFAULT_FILE_UPLOAD_TERMINAL_SESSION_TTL_MS)
    )
    expect(deleted).toBe(1)
    await expectSessionError(sessions.getForPrincipal(session.id, principal), {
      reason: "not_found",
      message: "File upload session not found.",
    })
  })

  test("does not allow completing a completed session twice", async () => {
    const sessions = new InMemoryFileUploadSessions()
    const session = await sessions.create({
      id: "upload_duplicate_complete",
      projectId: "test-project",
      principal,
      strategy: "server",
      expiresAt: futureDate(60_000),
    })

    await sessions.complete(session.id, fileRef)

    await expectSessionError(sessions.complete(session.id, fileRef), {
      reason: "already_completed",
      message: "File upload session is already completed.",
    })
  })

  test("an unswept store drops abandoned sessions on create; a swept one keeps them", async () => {
    const abandoned = {
      id: "upload_abandoned",
      projectId: "test-project",
      principal,
      strategy: "multipart" as const,
      expiresAt: new Date(Date.now() - 60_000),
      providerUpload: {
        strategy: "multipart" as const,
        uploadId: "upload_abandoned",
        partSizeBytes: 5 * 1024 * 1024,
        expiresAt: futureDate(60_000),
        stagingKey: "staging/upload_abandoned",
        providerUploadId: "provider-upload_abandoned",
      },
    }
    const next = {
      ...abandoned,
      id: "upload_next",
      providerUpload: undefined,
      strategy: "server" as const,
      expiresAt: futureDate(60_000),
    }
    const list = (store: InMemoryFileUploadSessions) =>
      store.listAbandoned({ projectId: "test-project", now: new Date(), limit: 10 })

    // No maintenance pass sees the files.ts fallback, so it must bound its own memory.
    const unswept = new InMemoryFileUploadSessions({ unswept: true })
    await unswept.create(abandoned)
    await unswept.create(next)
    expect(await list(unswept)).toEqual([])

    const swept = new InMemoryFileUploadSessions()
    await swept.create(abandoned)
    await swept.create(next)
    expect((await list(swept)).map((session) => session.id)).toEqual(["upload_abandoned"])
  })

  test("rolls back upload sessions with in-memory storage transactions", async () => {
    const storage = new InMemoryStorage()

    await expect(
      storage.transaction(async (tx) => {
        await tx.fileUploadSessions!.create({
          id: "upload_rollback",
          projectId: "test-project",
          principal,
          strategy: "server",
          expiresAt: futureDate(60_000),
        })
        throw new Error("rollback")
      })
    ).rejects.toThrow("rollback")

    await expectSessionError(
      storage.fileUploadSessions.getForPrincipal("upload_rollback", principal),
      {
        reason: "not_found",
        message: "File upload session not found.",
      }
    )
  })
})
