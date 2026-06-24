import { AuthStorageError } from "../errors"
import type {
  AuthServiceAccountStore,
  CreateAuthServiceAccountInput,
  ListAuthServiceAccountsInput,
  ListAuthServiceAccountsResult,
  ServiceAccountRecord,
  UpdateAuthServiceAccountInput,
} from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneDate,
  cloneOptionalRecord,
  cloneRecord,
  compareByCreatedAt,
  createServiceAccountRecord,
  serviceAccountKey,
} from "./shared"

export class InMemoryAuthServiceAccountStore implements AuthServiceAccountStore {
  constructor(private readonly state: AuthStorageState) {}

  async create(input: CreateAuthServiceAccountInput): Promise<ServiceAccountRecord> {
    return cloneRecord(createServiceAccountRecord(this.state, input))
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<ServiceAccountRecord | null> {
    const record =
      this.state.serviceAccounts.get(serviceAccountKey(params.projectId, params.id)) ?? null
    return cloneOptionalRecord(record)
  }

  async update(input: UpdateAuthServiceAccountInput): Promise<ServiceAccountRecord> {
    const projectId = assertNonEmpty(input.projectId, "Project id")
    const id = assertNonEmpty(input.id, "Service account id")
    const key = serviceAccountKey(projectId, id)
    const existing = this.state.serviceAccounts.get(key)

    if (!existing) {
      throw new AuthStorageError(
        "missing_service_account",
        `[Sixb] Service account '${id}' not found for project '${projectId}'.`
      )
    }

    const next: ServiceAccountRecord = {
      ...existing,
      name:
        input.name === undefined
          ? existing.name
          : assertNonEmpty(input.name, "Service account name"),
      description: input.description === undefined ? existing.description : input.description,
      status: input.status ?? existing.status,
      updatedAt: input.updatedAt ? cloneDate(input.updatedAt) : new Date(),
    }
    this.state.serviceAccounts.set(key, cloneRecord(next))
    return cloneRecord(next)
  }

  async list(input: ListAuthServiceAccountsInput): Promise<ListAuthServiceAccountsResult> {
    const statuses = input.statuses ? new Set(input.statuses) : null
    const order = input.order ?? "asc"
    const offset = input.offset ?? 0
    const rows = [...this.state.serviceAccounts.values()]
      .filter((serviceAccount) => serviceAccount.projectId === input.projectId)
      .filter((serviceAccount) => !statuses || statuses.has(serviceAccount.status))
      .sort((a, b) => compareByCreatedAt(a, b, order))
    const page = rows.slice(offset, input.limit === undefined ? undefined : offset + input.limit)

    return {
      serviceAccounts: page.map(cloneRecord),
      hasMore: input.limit === undefined ? false : offset + input.limit < rows.length,
      total: rows.length,
    }
  }
}
