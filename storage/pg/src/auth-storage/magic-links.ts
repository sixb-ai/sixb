import type { AuthMagicLinkStore, CreateAuthMagicLinkInput, MagicLinkRecord } from "@sixb/core"
import { AuthStorageError, resolveAuthSessionAudience } from "@sixb/core"
import type { SQL } from "bun"
import { authLockKey, lockAdvisoryKeys, runPgTransaction } from "../transactions"
import type { PgAuthMagicLinkRow } from "./rows"
import { rowToMagicLinkRecord } from "./rows"
import {
  assertNonEmpty,
  consumeMagicLink,
  getMagicLinkById,
  getMagicLinkRowById,
  mapUniqueConstraintError,
  normalizeEmail,
  revokeActiveMagicLinksForEmail,
} from "./shared"

export class PgAuthMagicLinkStore implements AuthMagicLinkStore {
  constructor(private readonly sql: SQL) {}

  async create(input: CreateAuthMagicLinkInput): Promise<MagicLinkRecord> {
    return runPgTransaction(this.sql, async (tx) => {
      const id = assertNonEmpty(input.id, "Magic link id")
      const projectId = assertNonEmpty(input.projectId, "Project id")
      const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
      const audience = resolveAuthSessionAudience(input.audience)
      const email = normalizeEmail(input.email)
      const tokenHash = assertNonEmpty(input.tokenHash, "Magic link token hash")

      await lockAdvisoryKeys(tx, [authLockKey("magic-links", projectId, email)])

      if (await getMagicLinkRowById(tx, { projectId, id })) {
        throw new AuthStorageError(
          "duplicate_magic_link",
          `[Sixb] Magic link '${id}' already exists for project '${projectId}'.`
        )
      }

      await revokeActiveMagicLinksForEmail(tx, {
        projectId,
        email,
        revokedAt: input.createdAt,
      })

      try {
        const [row] = (await tx`
          INSERT INTO auth_magic_links (
            project_id,
            id,
            strategy_id,
            audience,
            email,
            token_hash,
            return_to,
            created_at,
            expires_at
          ) VALUES (
            ${projectId},
            ${id},
            ${strategyId},
            ${audience},
            ${email},
            ${tokenHash},
            ${input.returnTo ?? null},
            ${input.createdAt},
            ${input.expiresAt}
          )
          RETURNING *
        `) as PgAuthMagicLinkRow[]

        return rowToMagicLinkRecord(row)
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_magic_link",
          `[Sixb] Magic link '${id}' already exists for project '${projectId}'.`
        )
      }
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<MagicLinkRecord | null> {
    return getMagicLinkById(this.sql, params)
  }

  async getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<MagicLinkRecord | null> {
    const [row] = (await this.sql`
      SELECT *
      FROM auth_magic_links
      WHERE project_id = ${params.projectId}
        AND email = ${normalizeEmail(params.email)}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${params.now}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `) as PgAuthMagicLinkRow[]

    return row ? rowToMagicLinkRecord(row) : null
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly consumedAt: Date
  }): Promise<MagicLinkRecord> {
    return runPgTransaction(this.sql, (tx) => consumeMagicLink(tx, params))
  }

  async revokeActiveForEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly revokedAt: Date
  }): Promise<readonly MagicLinkRecord[]> {
    return runPgTransaction(this.sql, async (tx) => {
      const email = normalizeEmail(params.email)
      await lockAdvisoryKeys(tx, [authLockKey("magic-links", params.projectId, email)])
      return revokeActiveMagicLinksForEmail(tx, {
        ...params,
        email,
      })
    })
  }
}
