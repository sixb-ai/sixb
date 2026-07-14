export const SESSION_ACTIVITY_HEADER_NAME = "x-sixb-session-activity"
const SESSION_ACTIVITY_HEADER_VALUE = "1"

export function hasForegroundSessionActivity(request: Request): boolean {
  return request.headers.get(SESSION_ACTIVITY_HEADER_NAME) === SESSION_ACTIVITY_HEADER_VALUE
}

export function isSessionTerminationRequest(request: Request): boolean {
  if (request.method.toUpperCase() !== "POST") {
    return false
  }

  const pathname = new URL(request.url).pathname
  return (
    pathname === "/api/auth/sign-out" ||
    pathname === "/api/auth/sign-out-all" ||
    /^\/api\/auth\/sessions\/[^/]+\/revoke$/.test(pathname)
  )
}
