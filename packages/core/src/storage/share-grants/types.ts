import type { Principal } from "../../auth"
import type { AuthorizablePrincipal } from "../../execution"
import type { ObjectRef } from "../../ontology"

export type SharedAccessGrantRef =
  | { readonly capability: "view"; readonly objectTypeId: string }
  | { readonly capability: "apply"; readonly actionId: string }

export interface SharedAccessGrantRecord {
  readonly id: string
  readonly projectId: string
  readonly shareTypeId: string
  readonly target: ObjectRef
  readonly issuedBy: AuthorizablePrincipal
  readonly grants: readonly SharedAccessGrantRef[]
  readonly tokenDigest: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
  readonly revokedBy?: Principal
}

export interface CreateSharedAccessGrantInput extends SharedAccessGrantRecord {
  readonly revokedAt?: never
  readonly revokedBy?: never
}

export interface GetSharedAccessGrantInput {
  readonly projectId: string
  readonly grantId: string
}

export interface ListSharedAccessGrantsInput {
  readonly projectId: string
  readonly shareTypeId?: string
  readonly target?: ObjectRef
  readonly includeRevoked?: boolean
  readonly includeExpired?: boolean
  readonly now?: Date
}

export interface RevokeSharedAccessGrantInput {
  readonly projectId: string
  readonly grantId: string
  readonly revokedAt: Date
  readonly revokedBy: Principal
}

export interface ShareGrantStorage {
  create(input: CreateSharedAccessGrantInput): Promise<SharedAccessGrantRecord>
  get(input: GetSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null>
  list(input: ListSharedAccessGrantsInput): Promise<readonly SharedAccessGrantRecord[]>
  revoke(input: RevokeSharedAccessGrantInput): Promise<SharedAccessGrantRecord | null>
}
