import type { Database } from "bun:sqlite"
import { resolveAuthSessionAudience } from "@sixb/core"
import type {
  AuthMagicLinkStore,
  CreateAuthMagicLinkInput,
  MagicLinkRecord,
} from "@sixb/core/storage"
import { authStorageError } from "@sixb/core/storage"
import { runImmediateTransaction } from "../transactions"
import type { SqliteAuthMagicLinkRow } from "./rows"
import { rowToMagicLinkRecord } from "./rows"
import {
  assertNonEmpty,
  consumeMagicLink,
  getMagicLinkById,
  getMagicLinkRowById,
  mapUniqueConstraintError,
  normalizeEmail,
  revokeActiveMagicLinksForEmail,
  toIso,
} from "./shared"

export class SqliteAuthMagicLinkStore implements AuthMagicLinkStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateAuthMagicLinkInput): Promise<MagicLinkRecord> {
    return runImmediateTransaction(this.db, () => {
      const id = assertNonEmpty(input.id, "Magic link id")
      const projectId = assertNonEmpty(input.projectId, "Project id")
      const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
      const audience = resolveAuthSessionAudience(input.audience)
      const email = normalizeEmail(input.email)
      const tokenHash = assertNonEmpty(input.tokenHash, "Magic link token hash")

      if (getMagicLinkRowById(this.db, { projectId, id })) {
        throw authStorageError(
          "duplicate_magic_link",
          `[Sixb] Magic link '${id}' already exists for project '${projectId}'.`
        )
      }

      revokeActiveMagicLinksForEmail(this.db, {
        projectId,
        email,
        revokedAt: input.createdAt,
      })

      try {
        this.db
          .query(
            `
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
          )
          .run(
            projectId,
            id,
            strategyId,
            audience,
            email,
            tokenHash,
            input.returnTo ?? null,
            toIso(input.createdAt),
            toIso(input.expiresAt)
          )
      } catch (error) {
        mapUniqueConstraintError(
          error,
          "duplicate_magic_link",
          `[Sixb] Magic link '${id}' already exists for project '${projectId}'.`
        )
      }

      return {
        id,
        projectId,
        strategyId,
        audience,
        email,
        tokenHash,
        returnTo: input.returnTo,
        createdAt: new Date(input.createdAt),
        expiresAt: new Date(input.expiresAt),
      }
    })
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<MagicLinkRecord | null> {
    return getMagicLinkById(this.db, params)
  }

  async getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<MagicLinkRecord | null> {
    const row = this.db
      .query(
        `
        SELECT *
        FROM auth_magic_links
        WHERE project_id = ?
          AND email = ?
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
      )
      .get(
        params.projectId,
        normalizeEmail(params.email),
        toIso(params.now)
      ) as SqliteAuthMagicLinkRow | null

    return row ? rowToMagicLinkRecord(row) : null
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly consumedAt: Date
  }): Promise<MagicLinkRecord> {
    return runImmediateTransaction(this.db, () => consumeMagicLink(this.db, params))
  }

  async revokeActiveForEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly revokedAt: Date
  }): Promise<readonly MagicLinkRecord[]> {
    return runImmediateTransaction(this.db, () => revokeActiveMagicLinksForEmail(this.db, params))
  }
}
