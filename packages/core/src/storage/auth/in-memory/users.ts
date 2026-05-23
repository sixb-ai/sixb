import { paginate } from "../../pagination"
import { AuthStorageError } from "../errors"
import type {
  AuthUserStore,
  CreateAuthUserInput,
  ListAuthUsersInput,
  ListAuthUsersResult,
  UpdateAuthUserProfileInput,
  UpdateAuthUserStatusInput,
  UserRecord,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  compareByCreatedAt,
  dateOrNow,
  getUserByEmail,
  normalizeEmail,
  userKey,
} from "./shared"

export class InMemoryAuthUserStore implements AuthUserStore {
  constructor(private readonly state: AuthStorageState) {}

  async create(input: CreateAuthUserInput): Promise<UserRecord> {
    const id = assertNonEmpty(input.id, "User id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const email = normalizeEmail(input.email)
    const key = userKey(projectId, id)

    if (this.state.users.has(key)) {
      throw new AuthStorageError(
        "duplicate_user",
        `[Sixb] User '${id}' already exists for project '${projectId}'.`
      )
    }

    if (getUserByEmail(this.state, projectId, email)) {
      throw new AuthStorageError(
        "duplicate_user",
        `[Sixb] User email '${email}' already exists for project '${projectId}'.`
      )
    }

    const createdAt = dateOrNow(input.createdAt)
    const user: UserRecord = {
      id,
      projectId,
      email,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      status: input.status ?? "active",
      createdAt,
      updatedAt: input.updatedAt ? cloneDate(input.updatedAt) : cloneDate(createdAt),
    }

    this.state.users.set(key, cloneRecord(user))
    return cloneRecord(user)
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<UserRecord | null> {
    const record = this.state.users.get(userKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async getByEmail(params: {
    readonly projectId: string
    readonly email: string
  }): Promise<UserRecord | null> {
    return cloneOptionalRecord(getUserByEmail(this.state, params.projectId, params.email))
  }

  async updateProfile(input: UpdateAuthUserProfileInput): Promise<UserRecord> {
    const key = userKey(input.projectId, input.id)
    const existing = this.state.users.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_user",
        `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const next: UserRecord = {
      ...existing,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      updatedAt: dateOrNow(input.updatedAt),
    }
    this.state.users.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async updateStatus(input: UpdateAuthUserStatusInput): Promise<UserRecord> {
    const key = userKey(input.projectId, input.id)
    const existing = this.state.users.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_user",
        `[Sixb] User '${input.id}' not found for project '${input.projectId}'.`
      )
    }

    const next: UserRecord = {
      ...existing,
      status: input.status,
      updatedAt: dateOrNow(input.updatedAt),
    }
    this.state.users.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async list(input: ListAuthUsersInput): Promise<ListAuthUsersResult> {
    if (input.statuses?.length === 0) {
      return { users: [], hasMore: false, total: 0 }
    }

    const statuses = input.statuses ? new Set(input.statuses) : null
    const order = input.order ?? "desc"
    const rows = [...this.state.users.values()]
      .filter((user) => user.projectId === input.projectId)
      .filter((user) => (statuses ? statuses.has(user.status) : true))
      .sort((a, b) => compareByCreatedAt(a, b, order))

    const page = paginate(rows, input)
    return {
      users: page.page.map(cloneRecord),
      hasMore: page.hasMore,
      total: page.total,
    }
  }
}
