import { assertAuthorized } from "../authorization"
import { isUserRef, type UserRef } from "../ontology/user-ref"
import type { SixbRuntimeContext } from "../runtime/types"
import type { UserRecord, UserStatus } from "../storage"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_SEARCH_LENGTH = 200
const MAX_EMAIL_LENGTH = 320

/** A member as the directory shows them. Read from auth storage, never from what a writer stored. */
export interface UserProfile {
  readonly id: string
  readonly email: string
  readonly displayName?: string
  readonly avatarUrl?: string
  readonly status: UserStatus
}

export interface ListUsersInput {
  /** Which members to list. Defaults to `"active"`. */
  readonly status?: UserStatus | "all"
  /**
   * Keep members whose display name or email contains this text, ignoring case. At most 200
   * characters.
   */
  readonly search?: string
  /** From 1 to 200. Defaults to 50. */
  readonly limit?: number
  readonly offset?: number
}

/** The member `users.get` reads: by user reference, or by email, matched exactly but ignoring case. */
export type UserLookup = UserRef | { readonly email: string }

/** One page of members, oldest first. */
export interface UsersPage {
  readonly users: readonly UserProfile[]
  readonly hasMore: boolean
  /** Every member matching the filters, across all pages. */
  readonly total: number
}

/** The project's member directory. Reading it requires `can.view(project.users)`. */
export interface UsersRuntime {
  /** The member's profile, suspended or not, or `null` when no member has this id or email. */
  get(user: UserLookup): Promise<UserProfile | null>
  list(input?: ListUsersInput): Promise<UsersPage>
}

export function createUsersRuntime(runtime: SixbRuntimeContext): UsersRuntime {
  const assertReadable = () => assertAuthorized(runtime, { kind: "users.view" })

  return {
    get: async (user) => {
      assertReadable()
      const lookup = userLookup(user)

      const users = runtime.storage.auth?.users
      if (!users) return null

      const record =
        "email" in lookup
          ? await users.getByEmail({ projectId: runtime.projectId, email: lookup.email })
          : await users.getById({ projectId: runtime.projectId, id: lookup.id })
      return record ? toUserProfile(record) : null
    },

    list: async (input = {}) => {
      assertReadable()

      const limit = listLimit(input.limit)
      const offset = listOffset(input.offset)
      const search = listSearch(input.search)

      const users = runtime.storage.auth?.users
      if (!users) return { users: [], hasMore: false, total: 0 }

      const page = await users.list({
        projectId: runtime.projectId,
        ...statusFilter(input.status),
        ...(search === undefined ? {} : { search }),
        limit,
        offset,
        order: "asc",
      })

      return {
        users: page.users.map(toUserProfile),
        hasMore: page.hasMore,
        total: page.total,
      }
    },
  }
}

/** Only the fields the directory shows: no project id, no timestamps. */
export function toUserProfile(record: UserRecord): UserProfile {
  return {
    id: record.id,
    email: record.email,
    ...(record.displayName === undefined ? {} : { displayName: record.displayName }),
    ...(record.avatarUrl === undefined ? {} : { avatarUrl: record.avatarUrl }),
    status: record.status,
  }
}

function userLookup(user: UserLookup): UserLookup {
  if (isUserRef(user)) return user
  if (isEmailLookup(user)) {
    const email = user.email.trim()
    if (email && email.length <= MAX_EMAIL_LENGTH) return { email }

    throw new Error(
      `[Sixb] users.get email must be nonblank and at most ${MAX_EMAIL_LENGTH} characters.`
    )
  }

  throw new Error(
    '[Sixb] users.get expects a user reference, such as userRef(id), or { email: "ava@acme.com" }.'
  )
}

function isEmailLookup(value: unknown): value is { readonly email: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 1 && keys[0] === "email" && typeof Reflect.get(value, "email") === "string"
}

function statusFilter(status: ListUsersInput["status"] = "active") {
  if (status === "all") return {}
  if (status === "active" || status === "suspended") return { statuses: [status] }

  throw new Error(`[Sixb] users.list status must be "active", "suspended", or "all".`)
}

function listSearch(search: string | undefined): string | undefined {
  const trimmed = search?.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= MAX_SEARCH_LENGTH) return trimmed

  throw new Error(`[Sixb] users.list search must be at most ${MAX_SEARCH_LENGTH} characters.`)
}

function listLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT) return limit

  throw new Error(`[Sixb] users.list limit must be an integer from 1 to ${MAX_LIMIT}.`)
}

function listOffset(offset: number | undefined): number {
  if (offset === undefined) return 0
  if (Number.isInteger(offset) && offset >= 0) return offset

  throw new Error("[Sixb] users.list offset must be a non-negative integer.")
}
