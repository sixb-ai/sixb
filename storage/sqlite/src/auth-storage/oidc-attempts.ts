import type { Database } from "bun:sqlite"
import { resolveAuthSessionAudience } from "@sixb/core"
import type {
  AuthOidcAuthorizationAttemptStore,
  CreateOidcAuthorizationAttemptInput,
  OidcAuthorizationAttemptRecord,
} from "@sixb/core/storage"
import { authStorageError } from "@sixb/core/storage"
import { runImmediateTransaction } from "../transactions"
import {
  assertNonEmpty,
  consumeOidcAttempt,
  getOidcAttemptById,
  getOidcAttemptRowById,
  mapUniqueConstraintError,
  toIso,
} from "./shared"

export class SqliteAuthOidcAuthorizationAttemptStore implements AuthOidcAuthorizationAttemptStore {
  constructor(private readonly db: Database) {}

  async create(
    input: CreateOidcAuthorizationAttemptInput
  ): Promise<OidcAuthorizationAttemptRecord> {
    return runImmediateTransaction(this.db, () => {
      const id = assertNonEmpty(input.id, "OIDC authorization attempt id")
      const projectId = assertNonEmpty(input.projectId, "Project id")
      const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
      const audience = resolveAuthSessionAudience(input.audience)
      const stateHash = assertNonEmpty(input.stateHash, "OIDC state hash")
      const nonceHash = assertNonEmpty(input.nonceHash, "OIDC nonce hash")
      const codeVerifier = assertNonEmpty(input.codeVerifier, "OIDC code verifier")

      if (getOidcAttemptRowById(this.db, { projectId, id })) {
        throw authStorageError(
          "duplicate_oidc_attempt",
          `[Sixb] OIDC authorization attempt '${id}' already exists for project '${projectId}'.`
        )
      }

      try {
        this.db
          .query(
            `
            INSERT INTO auth_oidc_authorization_attempts (
              project_id,
              id,
              strategy_id,
              audience,
              state_hash,
              nonce_hash,
              code_verifier,
              return_to,
              created_at,
              expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            projectId,
            id,
            strategyId,
            audience,
            stateHash,
            nonceHash,
            codeVerifier,
            input.returnTo ?? null,
            toIso(input.createdAt),
            toIso(input.expiresAt)
          )
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_oidc_attempt",
          `[Sixb] OIDC authorization attempt '${id}' already exists for project '${projectId}'.`
        )
      }

      return {
        id,
        projectId,
        strategyId,
        audience,
        stateHash,
        nonceHash,
        codeVerifier,
        returnTo: input.returnTo,
        createdAt: new Date(input.createdAt),
        expiresAt: new Date(input.expiresAt),
      }
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<OidcAuthorizationAttemptRecord | null> {
    return getOidcAttemptById(this.db, params)
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly stateHash: string
    readonly consumedAt: Date
  }): Promise<OidcAuthorizationAttemptRecord> {
    return runImmediateTransaction(this.db, () => consumeOidcAttempt(this.db, params))
  }
}
