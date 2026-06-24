import { AuthStorageError } from "../errors"
import type {
  AccessTokenRecord,
  AuthAccessTokenStore,
  CreateAuthAccessTokenInput,
  ListAuthAccessTokensInput,
  ListAuthAccessTokensResult,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  accessTokenKey,
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  compareByCreatedAt,
  createAccessTokenRecord,
  isActiveAccessToken,
} from "./shared"

export class InMemoryAuthAccessTokenStore implements AuthAccessTokenStore {
  constructor(private readonly state: AuthStorageState) {}

  async create(input: CreateAuthAccessTokenInput): Promise<AccessTokenRecord> {
    return cloneRecord(createAccessTokenRecord(this.state, input))
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AccessTokenRecord | null> {
    const record = this.state.accessTokens.get(accessTokenKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async list(input: ListAuthAccessTokensInput): Promise<ListAuthAccessTokensResult> {
    const order = input.order ?? "asc"
    const offset = input.offset ?? 0
    const rows = [...this.state.accessTokens.values()]
      .filter((token) => token.projectId === input.projectId)
      .filter((token) => input.kind === undefined || token.kind === input.kind)
      .filter((token) => input.subjectType === undefined || token.subjectType === input.subjectType)
      .filter((token) => input.subjectId === undefined || token.subjectId === input.subjectId)
      .filter((token) => input.includeRevoked || !token.revokedAt)
      .sort((a, b) => compareByCreatedAt(a, b, order))
    const page = rows.slice(offset, input.limit === undefined ? undefined : offset + input.limit)

    return {
      accessTokens: page.map(cloneRecord),
      hasMore: input.limit === undefined ? false : offset + input.limit < rows.length,
      total: rows.length,
    }
  }

  async findValidByTokenHash(params: {
    readonly projectId: string
    readonly id: string
    readonly kind: AccessTokenRecord["kind"]
    readonly tokenHash: string
    readonly now: Date
  }): Promise<AccessTokenRecord | null> {
    const token = this.state.accessTokens.get(accessTokenKey(params.projectId, params.id))
    if (
      !token ||
      token.kind !== params.kind ||
      token.tokenHash !== params.tokenHash ||
      !isActiveAccessToken(token, params.now)
    ) {
      return null
    }

    return cloneRecord(token)
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<AccessTokenRecord> {
    const key = accessTokenKey(params.projectId, params.id)
    const existing = this.state.accessTokens.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_access_token",
        `[Sixb] Access token '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const next: AccessTokenRecord = {
      ...existing,
      revokedAt: cloneDate(params.revokedAt),
    }
    this.state.accessTokens.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async touch(params: {
    readonly projectId: string
    readonly id: string
    readonly lastUsedAt: Date
    readonly userAgent?: string
    readonly ipAddress?: string
  }): Promise<AccessTokenRecord> {
    const key = accessTokenKey(params.projectId, params.id)
    const existing = this.state.accessTokens.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_access_token",
        `[Sixb] Access token '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const next: AccessTokenRecord = {
      ...existing,
      lastUsedAt: cloneDate(params.lastUsedAt),
      lastUsedUserAgent: params.userAgent ?? existing.lastUsedUserAgent,
      lastUsedIpAddress: params.ipAddress ?? existing.lastUsedIpAddress,
    }
    this.state.accessTokens.set(key, cloneRecord(next))
    return cloneRecord(next)
  }
}
