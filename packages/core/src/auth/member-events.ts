import type { EventDraft, PropertyChange, UserProfileUpdatedEvent } from "../events/types"
import type { CompleteSignInResult, InvitationRecord, UserRecord } from "../storage/auth"
import { toUserProfile } from "../users/execution"
import type { AuthenticatedUserRequestSession } from "./types"

type ProfileChanges = UserProfileUpdatedEvent["payload"]["changes"]

/**
 * What a completed sign-in tells the project: a new member, or the profile their identity provider
 * changed. A sign-in that changed nothing tells nothing.
 */
export function signInEvents(result: CompleteSignInResult): readonly EventDraft[] {
  const user = toUserProfile(result.user)

  if (result.previousUser === null) {
    return [
      {
        type: "user.joined",
        payload: {
          user,
          ...(result.invitation ? { invitationId: result.invitation.id } : {}),
        },
        idempotencyKey: `user.joined:${user.id}`,
      },
    ]
  }

  const changes = profileChanges(result.previousUser, result.user)
  if (!hasChanges(changes)) return []

  return [{ type: "user.profile.updated", payload: { user, changes } }]
}

/** A member edited their own profile. Saving the values it already had tells nothing. */
export function profileUpdatedEvents(
  caller: AuthenticatedUserRequestSession,
  previousUser: UserRecord,
  user: UserRecord
): readonly EventDraft[] {
  const changes = profileChanges(previousUser, user)
  if (!hasChanges(changes)) return []

  return [
    {
      type: "user.profile.updated",
      payload: { user: toUserProfile(user), changes, requestedBy: requester(caller) },
    },
  ]
}

export function statusChangedEvents(
  caller: AuthenticatedUserRequestSession,
  previousUser: UserRecord,
  user: UserRecord
): readonly EventDraft[] {
  if (previousUser.status === user.status) return []

  return [
    {
      type: user.status === "suspended" ? "user.suspended" : "user.reactivated",
      payload: { user: toUserProfile(user), requestedBy: requester(caller) },
    },
  ]
}

export function invitedEvents(
  caller: AuthenticatedUserRequestSession,
  invitation: InvitationRecord
): readonly EventDraft[] {
  return [
    {
      type: "user.invited",
      payload: {
        invitationId: invitation.id,
        email: invitation.email,
        expiresAt: invitation.expiresAt.toISOString(),
        requestedBy: requester(caller),
      },
    },
  ]
}

function profileChanges(before: UserRecord, after: UserRecord): ProfileChanges {
  const displayName = fieldChange(before.displayName, after.displayName)
  const avatarUrl = fieldChange(before.avatarUrl, after.avatarUrl)

  return {
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  }
}

function fieldChange(
  before: string | undefined,
  after: string | undefined
): PropertyChange<string> | undefined {
  if (after === undefined) {
    return before === undefined ? undefined : { operation: "cleared", before, after: null }
  }

  if (before === undefined) return { operation: "created", after }
  if (before === after) return undefined

  return { operation: "updated", before, after }
}

function hasChanges(changes: ProfileChanges): boolean {
  return changes.displayName !== undefined || changes.avatarUrl !== undefined
}

// Only the principal: the session behind it is not part of the event.
function requester(caller: AuthenticatedUserRequestSession) {
  return { type: caller.principal.type, id: caller.principal.id }
}
