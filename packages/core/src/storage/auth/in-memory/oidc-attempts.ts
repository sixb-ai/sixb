import { AuthStorageError } from "../errors"
import type {
  AuthOidcAuthorizationAttemptStore,
  CreateOidcAuthorizationAttemptInput,
  OidcAuthorizationAttemptRecord,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  consumeOidcAttemptRecord,
  oidcAttemptKey,
} from "./shared"

export class InMemoryAuthOidcAuthorizationAttemptStore
  implements AuthOidcAuthorizationAttemptStore
{
  constructor(private readonly state: AuthStorageState) {}

  async create(
    input: CreateOidcAuthorizationAttemptInput
  ): Promise<OidcAuthorizationAttemptRecord> {
    const id = assertNonEmpty(input.id, "OIDC authorization attempt id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
    const stateHash = assertNonEmpty(input.stateHash, "OIDC state hash")
    const nonceHash = assertNonEmpty(input.nonceHash, "OIDC nonce hash")
    const codeVerifier = assertNonEmpty(input.codeVerifier, "OIDC code verifier")
    const key = oidcAttemptKey(projectId, id)

    if (this.state.oidcAuthorizationAttempts.has(key)) {
      throw new AuthStorageError(
        "duplicate_oidc_attempt",
        `[Pario] OIDC authorization attempt '${id}' already exists for project '${projectId}'.`
      )
    }

    const attempt: OidcAuthorizationAttemptRecord = {
      id,
      projectId,
      strategyId,
      stateHash,
      nonceHash,
      codeVerifier,
      returnTo: input.returnTo,
      createdAt: cloneDate(input.createdAt),
      expiresAt: cloneDate(input.expiresAt),
    }
    this.state.oidcAuthorizationAttempts.set(key, cloneRecord(attempt))
    return cloneRecord(attempt)
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<OidcAuthorizationAttemptRecord | null> {
    const record =
      this.state.oidcAuthorizationAttempts.get(oidcAttemptKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<OidcAuthorizationAttemptRecord> {
    return cloneRecord(consumeOidcAttemptRecord(this.state, params))
  }
}
