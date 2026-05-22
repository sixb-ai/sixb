import type {
  AuthOidcAuthorizationAttemptStore,
  CreateOidcAuthorizationAttemptInput,
  OidcAuthorizationAttemptRecord,
} from "@pario/core"
import { AuthStorageError } from "@pario/core"
import type { SQL } from "bun"
import { runPgTransaction } from "../transactions"
import type { PgAuthOidcAttemptRow } from "./rows"
import { rowToOidcAuthorizationAttemptRecord } from "./rows"
import {
  assertNonEmpty,
  consumeOidcAttempt,
  getOidcAttemptById,
  getOidcAttemptRowById,
  mapUniqueConstraintError,
} from "./shared"

export class PgAuthOidcAuthorizationAttemptStore implements AuthOidcAuthorizationAttemptStore {
  constructor(private readonly sql: SQL) {}

  async create(
    input: CreateOidcAuthorizationAttemptInput
  ): Promise<OidcAuthorizationAttemptRecord> {
    const id = assertNonEmpty(input.id, "OIDC authorization attempt id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
    const stateHash = assertNonEmpty(input.stateHash, "OIDC state hash")
    const nonceHash = assertNonEmpty(input.nonceHash, "OIDC nonce hash")
    const codeVerifier = assertNonEmpty(input.codeVerifier, "OIDC code verifier")

    if (await getOidcAttemptRowById(this.sql, { projectId, id })) {
      throw new AuthStorageError(
        "duplicate_oidc_attempt",
        `[Pario] OIDC authorization attempt '${id}' already exists for project '${projectId}'.`
      )
    }

    try {
      const [row] = (await this.sql`
        INSERT INTO auth_oidc_authorization_attempts (
          project_id,
          id,
          strategy_id,
          state_hash,
          nonce_hash,
          code_verifier,
          return_to,
          created_at,
          expires_at
        ) VALUES (
          ${projectId},
          ${id},
          ${strategyId},
          ${stateHash},
          ${nonceHash},
          ${codeVerifier},
          ${input.returnTo ?? null},
          ${input.createdAt},
          ${input.expiresAt}
        )
        RETURNING *
      `) as PgAuthOidcAttemptRow[]

      return rowToOidcAuthorizationAttemptRecord(row)
    } catch (error) {
      mapUniqueConstraintError(
        error,
        "duplicate_oidc_attempt",
        `[Pario] OIDC authorization attempt '${id}' already exists for project '${projectId}'.`
      )
    }
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<OidcAuthorizationAttemptRecord | null> {
    return getOidcAttemptById(this.sql, params)
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<OidcAuthorizationAttemptRecord> {
    return runPgTransaction(this.sql, (tx) => consumeOidcAttempt(tx, params))
  }
}
