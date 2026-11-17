/**
 * When a session ends unless it is extended. It counts from the session's creation, a little
 * before it started running, so an extension comes early rather than late.
 */
export function sessionExpiry(session: {
  readonly createdAt?: Date
  readonly timeout?: number
}): Date | undefined {
  if (session.createdAt === undefined || session.timeout === undefined) return undefined
  return new Date(session.createdAt.getTime() + session.timeout)
}
