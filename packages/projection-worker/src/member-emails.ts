import type { ObjectProjectionDefinition } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { ProjectionWorkerContext } from "./types"

const PAGE_SIZE = 500

/** Member ids by normalized email: what a `userRef.fromEmail` column resolves against. */
export type MemberEmails = ReadonlyMap<string, string>

/**
 * Reads the member directory once per run, so every row of the run resolves against the same
 * members. Suspended members match too: the source still names them. `undefined` when the
 * projection maps no users, so other projections never read the directory.
 */
export async function loadMemberEmails(
  runtime: ProjectionWorkerContext,
  projection: ObjectProjectionDefinition
): Promise<MemberEmails | undefined> {
  if (!projection.users) return undefined

  const users = runtime.users
  if (!users) {
    throw createSixbError(
      "projection.definition_invalid",
      `[SixbProjectionWorker] Projection '${projection.id}' resolves members by email, but this runtime has no auth storage. Configure storage with auth.`,
      { details: { projectionId: projection.id } }
    )
  }

  const emails = new Map<string, string>()
  // Oldest first: a member who joins while the pages are read lands after them, never between.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await users.list({
      projectId: runtime.projectId,
      order: "asc",
      limit: PAGE_SIZE,
      offset,
    })
    for (const user of page.users) emails.set(normalizeEmail(user.email), user.id)
    if (!page.hasMore || page.users.length === 0) return emails
  }
}

/** Auth storage keeps emails trimmed and lowercased; a source may not. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
