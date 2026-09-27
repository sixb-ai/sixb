import { CSRF_HEADER_NAME } from "@sixb/core/internal/auth"
import { SHARED_ACCESS_GRANT_HEADER_NAME } from "../auth/shared-access"

export const SIXB_CSRF_SECURITY_SCHEME_ID = "sixbCsrf"
export const SIXB_SESSION_SECURITY_SCHEME_ID = "sixbSession"
export const SIXB_ACCESS_TOKEN_SECURITY_SCHEME_ID = "sixbAccessToken"
export const SIXB_SHARED_GRANT_SECURITY_SCHEME_ID = "sixbSharedGrant"

const csrf = { [SIXB_CSRF_SECURITY_SCHEME_ID]: [] as string[] }
const session = { [SIXB_SESSION_SECURITY_SCHEME_ID]: [] as string[] }
const accessToken = { [SIXB_ACCESS_TOKEN_SECURITY_SCHEME_ID]: [] as string[] }

// A browser session is its cookie, which OpenAPI leaves implicit: reads need nothing more, and
// mutations add the CSRF header. A native client's session is its bearer access token instead.

/** The default for every operation: any session. Public operations override it with `[]`. */
export const SIXB_SESSION_SECURITY_REQUIREMENT = [session]

/** A mutation taking a session: a browser's with its CSRF token, or a native client's. */
export const SIXB_SESSION_MUTATION_SECURITY_REQUIREMENT = [csrf, session]

// Public routes that still act for a session when one is sent list `{}`, meaning "or nothing", so
// generated clients send their credentials instead of omitting them.

/** Who-am-I: answers anyone, and describes the session when one is sent. */
export const SIXB_OPTIONAL_SESSION_SECURITY_REQUIREMENT = [session, {}]

/** Sign-out: succeeds for anyone, and ends the session when one is sent. */
export const SIXB_OPTIONAL_SESSION_MUTATION_SECURITY_REQUIREMENT = [csrf, session, {}]

/** A read that also accepts a personal or service-account access token. */
export const SIXB_ACCESS_TOKEN_READ_SECURITY_REQUIREMENT = [accessToken, session]

/** A mutation that also accepts a personal or service-account access token. */
export const SIXB_ACCESS_TOKEN_MUTATION_SECURITY_REQUIREMENT = [csrf, accessToken, session]

export const SIXB_SHARED_READ_SECURITY_REQUIREMENT = {
  [SIXB_SHARED_GRANT_SECURITY_SCHEME_ID]: [] as string[],
}

export const SIXB_SHARED_MUTATION_SECURITY_REQUIREMENT = {
  [SIXB_SHARED_GRANT_SECURITY_SCHEME_ID]: [] as string[],
  [SIXB_CSRF_SECURITY_SCHEME_ID]: [] as string[],
}

export const SIXB_CSRF_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: CSRF_HEADER_NAME,
  description:
    "Required for cookie-authenticated mutating requests. Use the csrfToken returned by the corresponding session endpoint.",
} as const

export const SIXB_SESSION_SECURITY_SCHEME = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Sixb session access token",
  description:
    "A signed-in native client's session access token, from device login and renewed through /api/auth/refresh. Accepted wherever a browser session is; browsers authenticate with the session cookie instead.",
} as const

export const SIXB_ACCESS_TOKEN_SECURITY_SCHEME = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Sixb access token",
  description:
    "A personal access token or service-account token, for scripts and services. Accepted only on routes that document this scheme. A native client's session token uses sixbSession instead.",
} as const

export const SIXB_SHARED_GRANT_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: SHARED_ACCESS_GRANT_HEADER_NAME,
  description:
    "Selects the shared grant whose grant-specific HttpOnly session cookie must authenticate the request.",
} as const
