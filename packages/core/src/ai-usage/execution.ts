import { randomUUID } from "node:crypto"
import { assertAuthorized, assertRuntimeAuthorizationBound, isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SecurityDefinitionCatalog } from "../security"
import type {
  AiAccountingOverview,
  AiLimitPolicy,
  AiLimitPolicyStatus,
  CreateAiLimitPolicyInput,
  ListAiLimitPoliciesInput,
  ListAiLimitPolicyStatusesInput,
  ListAiModelCallAccountingInput,
  ListAiModelCallAccountingResult,
  QueryAiAccountingOverviewInput,
  ServiceAccountStatus,
  UpdateAiLimitPolicyInput,
  UserStatus,
} from "../storage"

export type QueryAiUsageOverviewInput = Omit<QueryAiAccountingOverviewInput, "projectId">
export type ListAiUsageModelCallsInput = Omit<ListAiModelCallAccountingInput, "projectId">
export type ListAiUsageLimitPoliciesInput = Omit<ListAiLimitPoliciesInput, "projectId">
export type ListAiUsageLimitStatusesInput = Omit<
  ListAiLimitPolicyStatusesInput,
  "projectId" | "existingGroupIds" | "at"
>
export type CreateAiUsageLimitPolicyInput = Omit<
  CreateAiLimitPolicyInput,
  "id" | "projectId" | "createdAt"
> & { readonly id?: string }
export type UpdateAiUsageLimitPolicyInput = Omit<
  UpdateAiLimitPolicyInput,
  "projectId" | "updatedAt"
>

export interface AiUsageLimitGroupOption {
  readonly id: string
  readonly label?: string
  readonly description?: string
}

export interface AiUsageLimitUserOption {
  readonly id: string
  readonly email: string
  readonly displayName?: string
  readonly status: UserStatus
}

export interface AiUsageLimitServiceAccountOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly status: ServiceAccountStatus
}

export interface AiUsageLimitSubjectOptions {
  readonly groups: readonly AiUsageLimitGroupOption[]
  readonly users: readonly AiUsageLimitUserOption[]
  readonly serviceAccounts: readonly AiUsageLimitServiceAccountOption[]
}

/** Project AI accounting and limit controls bound to one execution's authority. */
export interface AiUsageRuntime {
  readonly accountingConfigured: boolean
  readonly limitsConfigured: boolean
  assertObservable(): void
  assertManageable(): void
  canManageLimits(): boolean
  queryOverview(input: QueryAiUsageOverviewInput): Promise<AiAccountingOverview>
  listModelCalls(input: ListAiUsageModelCallsInput): Promise<ListAiModelCallAccountingResult>
  listLimitPolicies(input?: ListAiUsageLimitPoliciesInput): Promise<readonly AiLimitPolicy[]>
  listLimitStatuses(input?: ListAiUsageLimitStatusesInput): Promise<readonly AiLimitPolicyStatus[]>
  listLimitSubjectOptions(): Promise<AiUsageLimitSubjectOptions>
  createLimitPolicy(input: CreateAiUsageLimitPolicyInput): Promise<AiLimitPolicy>
  updateLimitPolicy(input: UpdateAiUsageLimitPolicyInput): Promise<AiLimitPolicy>
  deleteLimitPolicy(id: string): Promise<boolean>
}

export function createAiUsageRuntime(
  runtime: SixbRuntimeContext,
  security: SecurityDefinitionCatalog
): AiUsageRuntime {
  const assertObservable = () => assertAuthorized(runtime, { kind: "aiUsage.observe" })
  const assertManageable = () => assertAuthorized(runtime, { kind: "aiUsage.manage" })
  const assertPolicyReadable = () => {
    const resolved = assertRuntimeAuthorizationBound(runtime)
    if (
      resolved.type === "principal" &&
      !isAllowed(resolved.context, { kind: "aiUsage.observe" }) &&
      !isAllowed(resolved.context, { kind: "aiUsage.manage" })
    ) {
      assertObservable()
    }
  }
  const requireCosts = () => {
    if (!runtime.storage.aiCosts) {
      throw new Error("[Sixb] AI cost storage is not configured.")
    }
    return runtime.storage.aiCosts
  }
  const requireLimits = () => {
    if (!runtime.storage.aiLimits) {
      throw new Error("[Sixb] AI limit storage is not configured.")
    }
    return runtime.storage.aiLimits
  }

  return {
    accountingConfigured: runtime.storage.aiCosts !== undefined,
    limitsConfigured: runtime.storage.aiLimits !== undefined,
    assertObservable,
    assertManageable,
    canManageLimits: () => {
      const resolved = assertRuntimeAuthorizationBound(runtime)
      return (
        resolved.type !== "principal" || isAllowed(resolved.context, { kind: "aiUsage.manage" })
      )
    },
    queryOverview: (input) => {
      assertObservable()
      return requireCosts().queryProjectOverview({ ...input, projectId: runtime.projectId })
    },
    listModelCalls: (input) => {
      assertObservable()
      return requireCosts().listModelCalls({ ...input, projectId: runtime.projectId })
    },
    listLimitPolicies: (input = {}) => {
      assertPolicyReadable()
      return requireLimits().listPolicies({ ...input, projectId: runtime.projectId })
    },
    listLimitStatuses: (input = {}) => {
      assertObservable()
      return requireLimits().listPolicyStatuses({
        ...(input.includeDisabled === undefined ? {} : { includeDisabled: input.includeDisabled }),
        projectId: runtime.projectId,
        existingGroupIds: security.listGroups().map((group) => group.id),
      })
    },
    listLimitSubjectOptions: async () => {
      assertManageable()
      const groups = security.listGroups().map((group) => ({
        id: group.id,
        ...(group.label === undefined ? {} : { label: group.label }),
        ...(group.description === undefined ? {} : { description: group.description }),
      }))
      const auth = runtime.storage.auth
      if (!auth) return { groups, users: [], serviceAccounts: [] }

      const [users, serviceAccounts] = await Promise.all([
        auth.users.list({ projectId: runtime.projectId, order: "asc" }),
        auth.serviceAccounts.list({ projectId: runtime.projectId, order: "asc" }),
      ])
      return {
        groups,
        users: users.users.map((user) => ({
          id: user.id,
          email: user.email,
          ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
          status: user.status,
        })),
        serviceAccounts: serviceAccounts.serviceAccounts.map((serviceAccount) => ({
          id: serviceAccount.id,
          name: serviceAccount.name,
          ...(serviceAccount.description === undefined
            ? {}
            : { description: serviceAccount.description }),
          status: serviceAccount.status,
        })),
      }
    },
    createLimitPolicy: (input) => {
      assertManageable()
      return requireLimits().createPolicy({
        ...input,
        id: input.id ?? `ailim_${randomUUID()}`,
        projectId: runtime.projectId,
      })
    },
    updateLimitPolicy: (input) => {
      assertManageable()
      return requireLimits().updatePolicy({ ...input, projectId: runtime.projectId })
    },
    deleteLimitPolicy: (id) => {
      assertManageable()
      return requireLimits().deletePolicy({ id, projectId: runtime.projectId })
    },
  }
}
