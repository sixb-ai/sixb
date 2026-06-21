import type {
  AuthServiceAccountGroupMembershipStore,
  ServiceAccountGroupMembershipRecord,
  UpsertAuthServiceAccountGroupMembershipInput,
} from "../types"
import type { AuthStorageState } from "./shared"
import { cloneRecord, upsertServiceAccountGroupMembershipRecord } from "./shared"

export class InMemoryAuthServiceAccountGroupMembershipStore
  implements AuthServiceAccountGroupMembershipStore
{
  constructor(private readonly state: AuthStorageState) {}

  async upsert(
    input: UpsertAuthServiceAccountGroupMembershipInput
  ): Promise<ServiceAccountGroupMembershipRecord> {
    return cloneRecord(upsertServiceAccountGroupMembershipRecord(this.state, input))
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
