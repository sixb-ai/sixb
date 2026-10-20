import { assertAuthorized } from "../authorization"
import { isUserRef, type UserRef } from "../ontology/user-ref"
import type { SixbRuntimeContext } from "../runtime/types"
import type { UserRecord, UserStatus } from "../storage"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_SEARCH_LENGTH = 200

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

/** One page of members, oldest first. */
export interface UsersPage {
  readonly users: readonly UserProfile[]
  readonly hasMore: boolean
  /** Every member matching the filters, across all pages. */
  readonly total: number
}

/** The project's member directory. Reading it requires `can.view(project.users)`. */
export interface UsersRuntime {
  /** The member's profile, suspended or not, or `null` when no member has this id. */
  get(user: UserRef): Promise<UserProfile | null>
  list(input?: ListUsersInput): Promise<UsersPage>
}

export function createUsersRuntime(runtime: SixbRuntimeContext): UsersRuntime {
  const assertReadable = () => assertAuthorized(runtime, { kind: "users.view" })

  return {
    get: async (user) => {
      assertReadable()

      if (!isUserRef(user)) {
        throw new Error("[Sixb] users.get expects a user reference, such as userRef(id).")
      }

      const users = runtime.storage.auth?.users
      if (!users) return null

      const record = await users.getById({ projectId: runtime.projectId, id: user.id })
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
