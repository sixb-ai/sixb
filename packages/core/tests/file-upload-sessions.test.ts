import { describe, expect, test } from "bun:test"
import type { Principal } from "../src"
import { InMemoryFileUploadSessions, InMemoryStorage } from "../src"
import type { FileUploadSessionErrorReason } from "../src/storage"
import { FileUploadSessionError } from "../src/storage"

const principal: Principal = { type: "system", id: "system" }

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
  test("records the owning principal and hides the session from every other principal", async () => {
    const sessions = new InMemoryFileUploadSessions()
    const owner: Principal = { type: "user", id: "usr_owner" }
    const session = await sessions.create({
      id: "upload_owned",
      projectId: "test-project",
      principal: owner,
      strategy: "server",
      expiresAt: futureDate(60_000),
    })

    expect(session.principal).toEqual({ type: "user", id: "usr_owner" })
    expect(await sessions.getForPrincipal(session.id, { type: "user", id: "usr_owner" })).toBe(
      session
    )
    for (const other of [
      { type: "serviceAccount", id: "usr_owner" },
      { type: "user", id: "usr_other" },
    ] satisfies Principal[]) {
      await expectSessionError(sessions.getForPrincipal(session.id, other), {
        reason: "not_found",
        message: "File upload session not found.",
      })
    }
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
