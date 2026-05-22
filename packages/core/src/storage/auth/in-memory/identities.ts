import type {
  AuthUserIdentityStore,
  UpsertAuthUserIdentityInput,
  UserIdentityRecord,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneOptionalRecord,
  cloneRecord,
  dateOrNow,
  identityKey,
  normalizeClaims,
} from "./shared"

export class InMemoryAuthUserIdentityStore implements AuthUserIdentityStore {
  constructor(private readonly state: AuthStorageState) {}

  async upsert(input: UpsertAuthUserIdentityInput): Promise<UserIdentityRecord> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
    const subject = assertNonEmpty(input.subject, "Subject")
    const userId = assertNonEmpty(input.userId, "User id")
    const key = identityKey(projectId, strategyId, subject)
    const existing = this.state.identities.get(key)
    const createdAt = existing?.createdAt ?? dateOrNow(input.createdAt)
    const identity: UserIdentityRecord = {
      projectId,
      strategyId,
      subject,
      userId,
      claims: normalizeClaims(input.claims),
      createdAt,
      updatedAt: input.updatedAt ? new Date(input.updatedAt) : existing ? new Date() : createdAt,
    }

    this.state.identities.set(key, cloneRecord(identity))
    return cloneRecord(identity)
  }

  async getBySubject(params: {
    readonly projectId: string
    readonly strategyId: string
    readonly subject: string
  }): Promise<UserIdentityRecord | null> {
    const record =
      this.state.identities.get(identityKey(params.projectId, params.strategyId, params.subject)) ??
      null
    return cloneOptionalRecord(record)
  }

  async listForUser(params: {
    readonly projectId: string
    readonly userId: string
  }): Promise<readonly UserIdentityRecord[]> {
    return [...this.state.identities.values()]
      .filter((identity) => identity.projectId === params.projectId)
      .filter((identity) => identity.userId === params.userId)
      .sort((a, b) => {
        const delta = a.createdAt.getTime() - b.createdAt.getTime()
        if (delta !== 0) return delta
        return `${a.strategyId}:${a.subject}`.localeCompare(`${b.strategyId}:${b.subject}`)
      })
      .map(cloneRecord)
  }
}
