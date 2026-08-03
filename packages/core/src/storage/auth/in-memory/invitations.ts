import { authStorageError } from "../../../storage/auth/errors"
import { paginate } from "../../pagination"
import type {
  AuthInvitationStore,
  CreateOrUpdateAuthInvitationInput,
  InvitationRecord,
  ListAuthInvitationsInput,
  ListAuthInvitationsResult,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  compareByCreatedAt,
  dateOrNow,
  getActiveInvitationByEmail,
  invitationKey,
  normalizeEmail,
  normalizeGroupIds,
} from "./shared"

export class InMemoryAuthInvitationStore implements AuthInvitationStore {
  constructor(private readonly state: AuthStorageState) {}

  async createOrUpdateActive(input: CreateOrUpdateAuthInvitationInput): Promise<InvitationRecord> {
    const id = assertNonEmpty(input.id, "Invitation id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const email = normalizeEmail(input.email)
    const groupIds = normalizeGroupIds(input.groupIds)
    const now = dateOrNow(input.updatedAt ?? input.createdAt)
    const existingActive = getActiveInvitationByEmail(this.state, projectId, email, now)

    if (existingActive) {
      const next: InvitationRecord = {
        ...existingActive,
        groupIds,
        createdByPrincipal: input.createdByPrincipal,
        createdBySessionId: input.createdBySessionId,
        expiresAt: cloneDate(input.expiresAt),
        updatedAt: now,
      }
      this.state.invitations.set(invitationKey(projectId, existingActive.id), cloneRecord(next))
      return cloneRecord(next)
    }

    const key = invitationKey(projectId, id)
    if (this.state.invitations.has(key)) {
      throw authStorageError(
        "duplicate_invitation",
        `[Sixb] Invitation '${id}' already exists but is not active for project '${projectId}'.`
      )
    }

    const invitation: InvitationRecord = {
      id,
      projectId,
      email,
      groupIds,
      status: "pending",
      createdByPrincipal: input.createdByPrincipal,
      createdBySessionId: input.createdBySessionId,
      createdAt: dateOrNow(input.createdAt),
      updatedAt: now,
      expiresAt: cloneDate(input.expiresAt),
    }
    this.state.invitations.set(key, cloneRecord(invitation))
    return cloneRecord(invitation)
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<InvitationRecord | null> {
    const record = this.state.invitations.get(invitationKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async getActiveByEmail(params: {
    readonly projectId: string
    readonly email: string
    readonly now: Date
  }): Promise<InvitationRecord | null> {
    return cloneOptionalRecord(
      getActiveInvitationByEmail(this.state, params.projectId, params.email, params.now)
    )
  }

  async list(input: ListAuthInvitationsInput): Promise<ListAuthInvitationsResult> {
    if (input.statuses?.length === 0 || input.groupIds?.length === 0) {
      return { invitations: [], hasMore: false, total: 0 }
    }

    const statuses = input.statuses ? new Set(input.statuses) : null
    const groupIds = input.groupIds ? new Set(input.groupIds) : null
    const email = input.email ? normalizeEmail(input.email) : null
    const order = input.order ?? "desc"
    const invitations = [...this.state.invitations.values()]
      .filter((invitation) => invitation.projectId === input.projectId)
      .filter((invitation) => (email ? invitation.email === email : true))
      .filter((invitation) => (statuses ? statuses.has(invitation.status) : true))
      .filter((invitation) =>
        groupIds ? invitation.groupIds.some((groupId) => groupIds.has(groupId)) : true
      )
      .sort((a, b) => compareByCreatedAt(a, b, order))

    const page = paginate(invitations, input)
    return {
      invitations: page.page.map(cloneRecord),
      hasMore: page.hasMore,
      total: page.total,
    }
  }

  async accept(params: {
    readonly projectId: string
    readonly id: string
    readonly acceptedAt: Date
  }): Promise<InvitationRecord> {
    const key = invitationKey(params.projectId, params.id)
    const existing = this.state.invitations.get(key)

    if (!existing) {
      throw authStorageError(
        "missing_invitation",
        `[Sixb] Invitation '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const next: InvitationRecord = {
      ...existing,
      status: "accepted",
      acceptedAt: cloneDate(params.acceptedAt),
      updatedAt: cloneDate(params.acceptedAt),
    }
    this.state.invitations.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async revoke(params: {
    readonly projectId: string
    readonly id: string
    readonly revokedAt: Date
  }): Promise<InvitationRecord> {
    const key = invitationKey(params.projectId, params.id)
    const existing = this.state.invitations.get(key)

    if (!existing) {
      throw authStorageError(
        "missing_invitation",
        `[Sixb] Invitation '${params.id}' not found for project '${params.projectId}'.`
      )
    }

    const next: InvitationRecord = {
      ...existing,
      status: "revoked",
      revokedAt: cloneDate(params.revokedAt),
      updatedAt: cloneDate(params.revokedAt),
    }
    this.state.invitations.set(key, cloneRecord(next))
    return cloneRecord(next)
  }
}
