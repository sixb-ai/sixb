import type { SixbRuntimeContext } from "../runtime/types"
import type { ActivityVisit, StoredActivityVisitPage } from "../storage/activity/types"
import type { SessionRecord } from "../storage/auth"
import { type ActivityDevice, describeUserAgent } from "./device"
import type { ActivityService } from "./service"

export type ActivityConnectionStatus = "active" | "expired" | "revoked"

/** A signed-in session. No address or token is kept here. */
export interface ActivitySessionConnection {
  readonly type: "session"
  readonly device: ActivityDevice
  /** A native client's own label, such as a CLI's. */
  readonly clientName?: string
  readonly status: ActivityConnectionStatus
  readonly createdAt: Date
  readonly lastSeenAt?: Date
  readonly revokedAt?: Date
}

/** The shared link a visitor opened, and the session it gave them. */
export interface ActivityShareConnection {
  readonly type: "share"
  readonly grantId: string
  /** Absent once the link's grant is gone. */
  readonly definitionId?: string
  readonly status: ActivityConnectionStatus
  readonly createdAt: Date
  readonly revokedAt?: Date
}

export type ActivityConnection = ActivitySessionConnection | ActivityShareConnection

/** A user's sign-in, with the visits it opened. */
export interface ActivityUserConnection extends ActivitySessionConnection {
  /** Every visit the session opened. */
  readonly visits: number
  /** Its latest visits, newest first. */
  readonly latestVisits: readonly ActivityVisit[]
}

export interface ActivityConnectionsPage {
  readonly connections: readonly ActivityUserConnection[]
  /** Pass it back as `cursor` for the next, older connections; absent on the last page. */
  readonly nextCursor?: string
}

export interface ActivityConnectionsQuery {
  readonly userId: string
  /** 1 to 100. Default: 20. */
  readonly limit?: number
  /** The previous page's `nextCursor`. */
  readonly cursor?: string
}

/** Where a list of sessions continues: a creation time, and how many created then it returned. */
export interface ActivityConnectionsCursor {
  readonly createdAt: Date
  readonly skip: number
}

/** A user's sign-ins, newest first, revoked and expired ones too: one read per store. */
export async function readActivityConnections(
  runtime: SixbRuntimeContext,
  service: ActivityService,
  query: ActivityConnectionsQuery,
  now: Date
): Promise<ActivityConnectionsPage> {
  const { userId, limit, before } = service.connectionsQuery(query)
  const sessions = runtime.storage.auth?.sessions
  if (!sessions) {
    return { connections: [] }
  }

  const page = await sessions.listByUserId({
    projectId: runtime.projectId,
    userId,
    limit,
    ...(before === undefined ? {} : { before }),
  })
  const visits = await service.sessionVisits({
    userId,
    sessionIds: page.sessions.map((session) => session.id),
  })
  const bySession = new Map(visits.map((entry) => [entry.sessionId, entry]))

  const connections = page.sessions.map((session) => ({
    ...sessionConnection(session, now),
    visits: bySession.get(session.id)?.visits ?? 0,
    latestVisits: bySession.get(session.id)?.latest ?? [],
  }))
  const last = page.sessions.at(-1)

  return {
    connections,
    ...(page.hasMore && last
      ? { nextCursor: nextConnectionsCursor(page.sessions, last, before) }
      : {}),
  }
}

/**
 * The cursor after a page: its last creation time, and how many sessions created then this page
 * and the ones before it returned. It names no session, so the session id never leaves core.
 */
function nextConnectionsCursor(
  sessions: readonly SessionRecord[],
  last: SessionRecord,
  before: ActivityConnectionsCursor | undefined
): string {
  const { createdAt } = last
  const tied = sessions.filter((session) => session.createdAt.getTime() === createdAt.getTime())
  const earlier = before && before.createdAt.getTime() === createdAt.getTime() ? before.skip : 0

  return encodeActivityConnectionsCursor({ createdAt, skip: earlier + tied.length })
}

export function encodeActivityConnectionsCursor(cursor: ActivityConnectionsCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.skip])).toString(
    "base64url"
  )
}

export function decodeActivityConnectionsCursor(value: string): ActivityConnectionsCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [at, skip] = parsed
      const createdAt = new Date(typeof at === "string" ? at : Number.NaN)
      if (Number.isFinite(createdAt.getTime()) && Number.isSafeInteger(skip) && skip >= 0) {
        return { createdAt, skip }
      }
    }
  } catch {
    // Reported below, like any other malformed cursor.
  }
  throw new Error("[Sixb] Invalid activity connections cursor.")
}

/** The session a visit came through: a sign-in, or a shared link. */
export async function readActivityConnection(
  runtime: SixbRuntimeContext,
  page: StoredActivityVisitPage,
  now: Date
): Promise<ActivityConnection | undefined> {
  const { storage, projectId } = runtime
  const { actor } = page.visit

  if (actor.type === "user") {
    const session = await storage.auth?.sessions.getById({ projectId, id: page.sessionId })
    return session ? sessionConnection(session, now) : undefined
  }

  const [session, grant] = await Promise.all([
    storage.shareSessions?.getById({ projectId, id: page.sessionId }),
    storage.shareGrants?.getById({ projectId, id: actor.grantId }),
  ])
  if (!session) {
    return undefined
  }

  // A session lasts no longer than its link: revoking or expiring the grant ends it too.
  const revokedAt = [session.revokedAt, grant?.revokedAt]
    .flatMap((at) => (at === undefined ? [] : [at.getTime()]))
    .sort((left, right) => left - right)[0]
  const statuses = [
    connectionStatus(session, now),
    ...(grant ? [connectionStatus(grant, now)] : []),
  ]
  const status = statuses.includes("revoked")
    ? "revoked"
    : statuses.includes("expired")
      ? "expired"
      : "active"

  return {
    type: "share",
    grantId: actor.grantId,
    ...(grant ? { definitionId: grant.definitionId } : {}),
    status,
    createdAt: new Date(session.createdAt),
    ...(revokedAt === undefined ? {} : { revokedAt: new Date(revokedAt) }),
  }
}

function connectionStatus(
  session: {
    readonly expiresAt: Date
    readonly absoluteExpiresAt?: Date
    readonly revokedAt?: Date
  },
  now: Date
): ActivityConnectionStatus {
  if (session.revokedAt) {
    return "revoked"
  }

  const expired =
    session.expiresAt <= now ||
    (session.absoluteExpiresAt !== undefined && session.absoluteExpiresAt <= now)
  return expired ? "expired" : "active"
}

/** A signed-in session as a connection, from its record and the time it is read at. */
function sessionConnection(session: SessionRecord, now: Date): ActivitySessionConnection {
  return {
    type: "session",
    device: describeUserAgent(session.userAgent),
    ...(session.bearer === undefined ? {} : { clientName: session.bearer.clientName }),
    status: connectionStatus(session, now),
    createdAt: new Date(session.createdAt),
    ...(session.lastSeenAt === undefined ? {} : { lastSeenAt: new Date(session.lastSeenAt) }),
    ...(session.revokedAt === undefined ? {} : { revokedAt: new Date(session.revokedAt) }),
  }
}
