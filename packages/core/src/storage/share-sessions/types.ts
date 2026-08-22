export interface SharedAccessSessionRecord {
  readonly id: string
  readonly projectId: string
  readonly grantId: string
  readonly tokenDigest: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly revokedAt?: Date
}

export interface CreateSharedAccessSessionInput extends SharedAccessSessionRecord {
  readonly revokedAt?: never
}

export interface GetSharedAccessSessionInput {
  readonly projectId: string
  readonly sessionId: string
}

export interface RevokeSharedAccessSessionInput {
  readonly projectId: string
  readonly sessionId: string
  readonly revokedAt: Date
}

export interface ShareSessionStorage {
  create(input: CreateSharedAccessSessionInput): Promise<SharedAccessSessionRecord>
  get(input: GetSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null>
  revoke(input: RevokeSharedAccessSessionInput): Promise<SharedAccessSessionRecord | null>
}
