import { AuthStorageError } from "../errors"
import type {
  AuthDeviceAuthorizationStore,
  CreateDeviceAuthorizationInput,
  DeviceAuthorizationRecord,
} from "../types"
import { MAX_PENDING_DEVICE_AUTHORIZATIONS } from "../types"
import type { AuthStorageState } from "./shared"
import {
  assertNonEmpty,
  cloneRecord,
  deviceAuthorizationKey,
  isActiveSession,
  sessionKey,
  userKey,
} from "./shared"

export class InMemoryAuthDeviceAuthorizationStore implements AuthDeviceAuthorizationStore {
  constructor(private readonly state: AuthStorageState) {}

  async create(input: CreateDeviceAuthorizationInput): Promise<DeviceAuthorizationRecord> {
    const id = assertNonEmpty(input.id, "Device authorization id")
    const projectId = assertNonEmpty(input.projectId, "Project id")
    for (const [key, authorization] of this.state.deviceAuthorizations) {
      if (authorization.projectId === projectId && authorization.expiresAt <= input.createdAt) {
        this.state.deviceAuthorizations.delete(key)
      }
    }
    const pending = [...this.state.deviceAuthorizations.values()].filter(
      (authorization) => authorization.projectId === projectId && authorization.status === "pending"
    ).length
    if (pending >= MAX_PENDING_DEVICE_AUTHORIZATIONS) {
      throw new AuthStorageError(
        "device_authorization_limit_exceeded",
        `[Sixb] Project '${projectId}' has too many pending device authorizations.`
      )
    }
    const key = deviceAuthorizationKey(projectId, id)
    if (this.state.deviceAuthorizations.has(key)) {
      throw duplicateAuthorization(id, projectId)
    }
    const record: DeviceAuthorizationRecord = {
      id,
      projectId,
      deviceCodeHash: assertNonEmpty(input.deviceCodeHash, "Device code hash"),
      userCode: assertNonEmpty(input.userCode, "User code"),
      clientName: assertNonEmpty(input.clientName, "Client name"),
      tokenName: assertNonEmpty(input.tokenName, "Token name"),
      tokenExpiresAt: new Date(input.tokenExpiresAt),
      status: "pending",
      createdAt: new Date(input.createdAt),
      expiresAt: new Date(input.expiresAt),
    }
    this.state.deviceAuthorizations.set(key, cloneRecord(record))
    return cloneRecord(record)
  }

  async getById(params: { readonly projectId: string; readonly id: string }) {
    const record = this.state.deviceAuthorizations.get(
      deviceAuthorizationKey(params.projectId, params.id)
    )
    return record ? cloneRecord(record) : null
  }

  async getByUserCode(params: { readonly projectId: string; readonly userCode: string }) {
    for (const record of this.state.deviceAuthorizations.values()) {
      if (record.projectId === params.projectId && record.userCode === params.userCode) {
        return cloneRecord(record)
      }
    }
    return null
  }

  async approve(params: {
    readonly projectId: string
    readonly id: string
    readonly userId: string
    readonly sessionId: string
    readonly approvedAt: Date
  }): Promise<DeviceAuthorizationRecord> {
    const record = this.requirePending(params.projectId, params.id, params.approvedAt)
    const user = this.state.users.get(userKey(params.projectId, params.userId))
    const session = this.state.sessions.get(sessionKey(params.projectId, params.sessionId))
    if (
      !user ||
      user.status !== "active" ||
      !session ||
      session.userId !== user.id ||
      !isActiveSession(session, params.approvedAt)
    ) {
      throw new AuthStorageError(
        "invalid_device_authorization",
        "[Sixb] Device authorization requires an active user session."
      )
    }
    const next: DeviceAuthorizationRecord = {
      ...record,
      status: "approved",
      approvedUserId: assertNonEmpty(params.userId, "Approved user id"),
      approvedSessionId: assertNonEmpty(params.sessionId, "Approved session id"),
      approvedAt: new Date(params.approvedAt),
    }
    this.state.deviceAuthorizations.set(deviceAuthorizationKey(params.projectId, params.id), next)
    return cloneRecord(next)
  }

  async deny(params: {
    readonly projectId: string
    readonly id: string
    readonly deniedAt: Date
  }): Promise<DeviceAuthorizationRecord> {
    const record = this.requirePending(params.projectId, params.id, params.deniedAt)
    const next: DeviceAuthorizationRecord = {
      ...record,
      status: "denied",
      deniedAt: new Date(params.deniedAt),
    }
    this.state.deviceAuthorizations.set(deviceAuthorizationKey(params.projectId, params.id), next)
    return cloneRecord(next)
  }

  private requirePending(projectId: string, id: string, now: Date): DeviceAuthorizationRecord {
    const record = this.state.deviceAuthorizations.get(deviceAuthorizationKey(projectId, id))
    if (!record) {
      throw new AuthStorageError(
        "missing_device_authorization",
        `[Sixb] Device authorization '${id}' not found for project '${projectId}'.`
      )
    }
    if (record.status !== "pending" || record.expiresAt <= now) {
      throw new AuthStorageError(
        "invalid_device_authorization",
        `[Sixb] Device authorization '${id}' is no longer pending for project '${projectId}'.`
      )
    }
    return record
  }
}

function duplicateAuthorization(id: string, projectId: string): AuthStorageError {
  return new AuthStorageError(
    "duplicate_device_authorization",
    `[Sixb] Device authorization '${id}' already exists for project '${projectId}'.`
  )
}
