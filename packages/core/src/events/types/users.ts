import type { AuthorizablePrincipal } from "../../execution/types"
import type { UserProfile } from "../../users"
import type { EventEnvelope } from "../envelope"
import type { PropertyChange } from "../property-changes"

/** A person signed in for the first time, which created their account. */
export interface UserJoinedEvent extends EventEnvelope {
  type: "user.joined"
  topic: "users"
  partitionKey: string
  payload: {
    user: UserProfile
    /** The invitation they accepted. Absent when they joined without one. */
    invitationId?: string
  }
}

export interface UserSuspendedEvent extends EventEnvelope {
  type: "user.suspended"
  topic: "users"
  partitionKey: string
  payload: {
    user: UserProfile
    requestedBy: AuthorizablePrincipal
  }
}

export interface UserReactivatedEvent extends EventEnvelope {
  type: "user.reactivated"
  topic: "users"
  partitionKey: string
  payload: {
    user: UserProfile
    requestedBy: AuthorizablePrincipal
  }
}

/** Someone was invited. They become a member, with `user.joined`, at their first sign-in. */
export interface UserInvitedEvent extends EventEnvelope {
  type: "user.invited"
  topic: "users"
  partitionKey: string
  payload: {
    invitationId: string
    email: string
    expiresAt: string
    requestedBy: AuthorizablePrincipal
  }
}

/** A member's name or picture changed. */
export interface UserProfileUpdatedEvent extends EventEnvelope {
  type: "user.profile.updated"
  topic: "users"
  partitionKey: string
  payload: {
    user: UserProfile
    /** Only the fields that changed. */
    changes: {
      displayName?: PropertyChange<string>
      avatarUrl?: PropertyChange<string>
    }
    /** The member who edited their profile. Absent when their identity provider changed it. */
    requestedBy?: AuthorizablePrincipal
  }
}

export type UserEvent =
  | UserJoinedEvent
  | UserSuspendedEvent
  | UserReactivatedEvent
  | UserInvitedEvent
  | UserProfileUpdatedEvent
