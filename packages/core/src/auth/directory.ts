import type { AuthStorage, DirectoryVerdict, UserIdentityRecord, UserRecord } from "../storage/auth"
import { AuthRuntimeError } from "./errors"
import type { AuthStrategyDirectory } from "./types"

const DEFAULT_INTERVAL_MS = 60 * 60_000
const MIN_INTERVAL_MS = 60_000
const DEFAULT_CONFIRM_AFTER_MS = 60_000
// The confirming read must fit in the pass's budget with the two reads around it.
const MAX_CONFIRM_AFTER_MS = 5 * 60_000
// Users read per storage call while a pass resolves its identities.
const USER_BATCH = 500

export interface DirectorySchedule {
  readonly intervalMs: number
  readonly confirmAfterMs: number
}

export interface DirectoryChange {
  readonly user: UserRecord
  readonly verdict: DirectoryVerdict
}

/** The directory's timing, checked once when auth starts. */
export function directorySchedule(directory: AuthStrategyDirectory): DirectorySchedule {
  const intervalMs = directory.intervalMs ?? DEFAULT_INTERVAL_MS
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] The auth strategy's directory intervalMs must be at least 60000 (one minute)."
    )
  }
  const confirmAfterMs = directory.confirmAfterMs ?? DEFAULT_CONFIRM_AFTER_MS
  if (
    !Number.isFinite(confirmAfterMs) ||
    confirmAfterMs < 0 ||
    confirmAfterMs > MAX_CONFIRM_AFTER_MS
  ) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] The auth strategy's directory confirmAfterMs must be from 0 to 300000 (five minutes)."
    )
  }
  return { intervalMs, confirmAfterMs }
}

/**
 * Reads the directory's verdict on every identity one strategy linked, and decides what to apply:
 *
 * - A directory can answer from before a recent change for a while, and an administrator may
 *   unassign someone a moment before assigning them a new role. So a pass that would suspend or
 *   reactivate someone reads again `confirmAfterMs` later, and keeps only the status changes both
 *   reads agree on. One the second read doesn't confirm waits for the next pass.
 * - A pass that would suspend more than a quarter of the active members it checked, and more than
 *   two, throws instead: that looks like a misconfigured directory, not a wave of departures.
 *
 * Returns only verdicts that change something: a status, or the groups the directory grants.
 */
export async function planDirectoryPass(input: {
  readonly projectId: string
  readonly storage: AuthStorage
  readonly strategyId: string
  readonly directory: AuthStrategyDirectory
  readonly confirmAfterMs: number
  readonly signal: AbortSignal
}): Promise<readonly DirectoryChange[]> {
  const { projectId, storage, directory, signal } = input
  const identities = await storage.identities.listForStrategy({
    projectId,
    strategyId: input.strategyId,
  })
  if (identities.length === 0) return []

  const read = async () => {
    const verdicts = await directory.check({ identities, signal })
    const users = await usersById(storage, projectId, identities)
    return changesFrom(identities, verdicts, users)
  }

  let changes = await read()
  if (changes.some(changesStatus)) {
    await delay(input.confirmAfterMs, signal)
    const first = new Map(changes.map(({ user, verdict }) => [user.id, verdict.status]))
    changes = (await read()).filter(
      (change) => !changesStatus(change) || first.get(change.user.id) === change.verdict.status
    )
  }

  const activeMembers = changes.filter(({ user }) => user.status === "active").length
  const suspensions = changes.filter(
    ({ user, verdict }) => verdict.status === "inactive" && user.status === "active"
  ).length
  if (suspensions > Math.max(2, activeMembers / 4)) {
    throw new Error(
      `[Sixb] The directory check would suspend ${suspensions} members at once, so it suspended ` +
        "no one. Check the directory's configuration, or suspend them in Settings › Members."
    )
  }

  return changes.filter(
    (change) =>
      changesStatus(change) ||
      (change.verdict.status === "active" && change.verdict.groupIds !== undefined)
  )
}

/** Whether applying this verdict would suspend or reactivate the member. */
function changesStatus({ user, verdict }: DirectoryChange): boolean {
  return verdict.status === "inactive"
    ? user.status === "active"
    : user.status === "suspended" && user.suspensionSource === "directory"
}

/**
 * One verdict per member the directory answered for. A member with several identities stays
 * active while any of them is.
 */
function changesFrom(
  identities: readonly UserIdentityRecord[],
  verdicts: ReadonlyMap<string, DirectoryVerdict>,
  users: ReadonlyMap<string, UserRecord>
): readonly DirectoryChange[] {
  const changes = new Map<string, DirectoryChange>()
  for (const identity of identities) {
    const verdict = verdicts.get(identity.subject)
    const user = users.get(identity.userId)
    if (!verdict || !user) continue
    const existing = changes.get(user.id)
    if (!existing || (existing.verdict.status === "inactive" && verdict.status === "active")) {
      changes.set(user.id, { user, verdict })
    }
  }
  return [...changes.values()]
}

async function usersById(
  storage: AuthStorage,
  projectId: string,
  identities: readonly UserIdentityRecord[]
): Promise<ReadonlyMap<string, UserRecord>> {
  const ids = [...new Set(identities.map((identity) => identity.userId))]
  const users = new Map<string, UserRecord>()
  for (let start = 0; start < ids.length; start += USER_BATCH) {
    const batch = await storage.users.getByIds({
      projectId,
      ids: ids.slice(start, start + USER_BATCH),
    })
    for (const user of batch) users.set(user.id, user)
  }
  return users
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (ms === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
