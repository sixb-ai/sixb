import type { Storage, UserStatus } from "../storage"
import { toUserProfile, type UserProfile } from "../users/execution"

/** A member to seed, with the fields the member directory shows. */
export interface TestUser {
  readonly id: string
  readonly email: string
  readonly displayName?: string
  readonly avatarUrl?: string
  /** Defaults to `"active"`. */
  readonly status?: UserStatus
}

/**
 * Add members to a test host, so objects, actions and workflows can reference them with
 * `userRef(id)`. Ids and emails must be unique in the project. Returns their profiles, in order.
 */
export async function seedTestUsers(
  host: { readonly id: string; readonly storage: Pick<Storage, "auth"> },
  users: readonly TestUser[]
): Promise<UserProfile[]> {
  const store = host.storage.auth?.users
  if (!store) {
    throw new Error("[Sixb] seedTestUsers needs storage with auth, such as InMemoryStorage.")
  }

  // A millisecond apart: the directory lists members oldest first, so it keeps the order given.
  const seededAt = Date.now()
  const profiles: UserProfile[] = []
  for (const [index, user] of users.entries()) {
    const record = await store.create({
      ...user,
      projectId: host.id,
      createdAt: new Date(seededAt + index),
    })
    profiles.push(toUserProfile(record))
  }
  return profiles
}
