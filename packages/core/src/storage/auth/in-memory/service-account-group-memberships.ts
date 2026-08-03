import { authStorageError } from "../../../storage/auth/errors"
import type {
  AuthServiceAccountGroupMembershipStore,
  ReconcileAuthServiceAccountGroupMembershipsInput,
  ServiceAccountGroupMembershipRecord,
  UpsertAuthServiceAccountGroupMembershipInput,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneRecord,
  dateOrNow,
  normalizeGroupIds,
  serviceAccountGroupMembershipKey,
  serviceAccountKey,
  upsertServiceAccountGroupMembershipRecord,
} from "./shared"

export class InMemoryAuthServiceAccountGroupMembershipStore
  implements AuthServiceAccountGroupMembershipStore
{
  constructor(private readonly state: AuthStorageState) {}

  async upsert(
    input: UpsertAuthServiceAccountGroupMembershipInput
  ): Promise<ServiceAccountGroupMembershipRecord> {
    return cloneRecord(upsertServiceAccountGroupMembershipRecord(this.state, input))
  }

  async reconcileForServiceAccount(
    input: ReconcileAuthServiceAccountGroupMembershipsInput
  ): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const serviceAccountId = assertNonEmpty(input.serviceAccountId, "Service account id")
    if (!this.state.serviceAccounts.has(serviceAccountKey(projectId, serviceAccountId))) {
      throw authStorageError(
        "missing_service_account",
        `[Sixb] Service account '${serviceAccountId}' not found for project '${projectId}'.`
      )
    }

    const groupIds = normalizeGroupIds(input.groupIds)
    const desired = new Set(groupIds)
    for (const [key, membership] of this.state.serviceAccountGroupMemberships) {
      if (
        membership.projectId === projectId &&
        membership.serviceAccountId === serviceAccountId &&
        membership.source === input.source &&
        !desired.has(membership.groupId)
      ) {
        this.state.serviceAccountGroupMemberships.delete(key)
      }
    }

    const updatedAt = dateOrNow(input.updatedAt)
    for (const groupId of groupIds) {
      const key = serviceAccountGroupMembershipKey(projectId, serviceAccountId, groupId)
      const existing = this.state.serviceAccountGroupMemberships.get(key)
      if (existing) {
        this.state.serviceAccountGroupMemberships.set(
          key,
          cloneRecord({ ...existing, source: input.source })
        )
        continue
      }
      this.state.serviceAccountGroupMemberships.set(
        key,
        cloneRecord({
          projectId,
          serviceAccountId,
          groupId,
          source: input.source,
          createdAt: updatedAt,
        })
      )
    }

    return this.listForServiceAccount({ projectId, serviceAccountId })
  }

  async listForServiceAccount(params: {
    readonly projectId: string
    readonly serviceAccountId: string
  }): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    return [...this.state.serviceAccountGroupMemberships.values()]
      .filter((membership) => membership.projectId === params.projectId)
      .filter((membership) => membership.serviceAccountId === params.serviceAccountId)
      .sort((a, b) => a.groupId.localeCompare(b.groupId))
      .map(cloneRecord)
  }

  async listForGroup(params: {
    readonly projectId: string
    readonly groupId: string
  }): Promise<readonly ServiceAccountGroupMembershipRecord[]> {
    return [...this.state.serviceAccountGroupMemberships.values()]
      .filter((membership) => membership.projectId === params.projectId)
      .filter((membership) => membership.groupId === params.groupId)
      .sort((a, b) => a.serviceAccountId.localeCompare(b.serviceAccountId))
      .map(cloneRecord)
  }
}
