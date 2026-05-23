import { resolveAuthSessionAudience } from "../../../auth/audience"
import { AuthStorageError } from "../errors"
import type { AuthMagicLinkStore, CreateAuthMagicLinkInput, MagicLinkRecord } from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  compareByCreatedAt,
  consumeMagicLinkRecord,
  isActiveMagicLink,
  magicLinkKey,
  normalizeEmail,
  revokeActiveMagicLinksForEmail,
} from "./shared"

export class InMemoryAuthMagicLinkStore implements AuthMagicLinkStore {
  constructor(private readonly state: AuthStorageState) {}

  async create(input: CreateAuthMagicLinkInput): Promise<MagicLinkRecord> {
    const id = assertNonEmpty(input.id, "Magic link id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const strategyId = assertNonEmpty(input.strategyId, "Strategy id")
    const audience = resolveAuthSessionAudience(input.audience)
    const email = normalizeEmail(input.email)
    const tokenHash = assertNonEmpty(input.tokenHash, "Magic link token hash")
    const key = magicLinkKey(projectId, id)

    if (this.state.magicLinks.has(key)) {
      throw new AuthStorageError(
        "duplicate_magic_link",
        `[Pario] Magic link '${id}' already exists for project '${projectId}'.`
      )
    }

    revokeActiveMagicLinksForEmail(this.state, projectId, email, input.createdAt)

    const link: MagicLinkRecord = {
      id,
      projectId,
      strategyId,
      audience,
      email,
      tokenHash,
      returnTo: input.returnTo,
      createdAt: cloneDate(input.createdAt),
      expiresAt: cloneDate(input.expiresAt),
    }
    this.state.magicLinks.set(key, cloneRecord(link))
    return cloneRecord(link)
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<MagicLinkRecord | null> {
    const record = this.state.magicLinks.get(magicLinkKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<MagicLinkRecord | null> {
    const email = normalizeEmail(params.email)
    const links = [...this.state.magicLinks.values()]
      .filter((link) => link.projectId === params.projectId)
      .filter((link) => link.email === email)
      .filter((link) => isActiveMagicLink(link, params.now))
      .sort((a, b) => compareByCreatedAt(a, b, "desc"))

    return cloneOptionalRecord(links[0] ?? null)
  }

  async consume(params: {
    readonly projectId: string
    readonly id: string
    readonly tokenHash: string
    readonly consumedAt: Date
  }): Promise<MagicLinkRecord> {
    return cloneRecord(consumeMagicLinkRecord(this.state, params))
  }

  async revokeActiveForEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly revokedAt: Date
  }): Promise<readonly MagicLinkRecord[]> {
    return revokeActiveMagicLinksForEmail(
      this.state,
      params.projectId,
      params.email,
      params.revokedAt
    ).map(cloneRecord)
  }
}
