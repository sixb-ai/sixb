import type { ObjectProjectionDefinition, ProjectionUserKey } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { ProjectionWorkerContext } from "./types"

const PAGE_SIZE = 500

/** What a `userRef.fromEmail` or `userRef.fromId` column resolves against. */
export interface MemberDirectory {
  /** Member ids by normalized email. */
  readonly emails: ReadonlyMap<string, string>
  readonly ids: ReadonlySet<string>
}

/**
 * Reads the member directory once per run, so every row of the run resolves against the same
 * members. Suspended members match too: the source still names them. `undefined` when the
 * projection maps no users, so other projections never read the directory.
 */
export async function loadMemberDirectory(
  runtime: ProjectionWorkerContext,
  projection: ObjectProjectionDefinition
): Promise<MemberDirectory | undefined> {
  if (!projection.users) return undefined

  const users = runtime.users
  if (!users) {
    const keys = [...new Set(Object.values(projection.users))].join(" and ")
    throw createSixbError(
      "projection.definition_invalid",
      `[SixbProjectionWorker] Projection '${projection.id}' resolves members by ${keys}, but this runtime has no auth storage. Configure storage with auth.`,
      { details: { projectionId: projection.id } }
    )
  }

  const emails = new Map<string, string>()
  const ids = new Set<string>()
  // Oldest first: a member who joins while the pages are read lands after them, never between.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await users.list({
      projectId: runtime.projectId,
      order: "asc",
      limit: PAGE_SIZE,
      offset,
    })
    for (const user of page.users) {
      emails.set(normalizeEmail(user.email), user.id)
      ids.add(user.id)
    }
    if (!page.hasMore || page.users.length === 0) return { emails, ids }
  }
}

/** The id of the member `value` names by `key`, or `undefined` when no member has it. */
export function resolveMember(
  directory: MemberDirectory,
  key: ProjectionUserKey,
  value: string
): string | undefined {
  if (key === "email") return directory.emails.get(normalizeEmail(value))
  return directory.ids.has(value) ? value : undefined
}

/** Auth storage keeps emails trimmed and lowercased; a source may not. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
