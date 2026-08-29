import { CSRF_HEADER_NAME } from "@sixb/core/internal/auth"
import { SHARED_ACCESS_GRANT_HEADER_NAME } from "../auth/shared-access"

export const SIXB_CSRF_SECURITY_SCHEME_ID = "sixbCsrf"
export const SIXB_BEARER_SECURITY_SCHEME_ID = "sixbBearer"
export const SIXB_SHARED_GRANT_SECURITY_SCHEME_ID = "sixbSharedGrant"

export const SIXB_CSRF_SECURITY_REQUIREMENT = [
  {
    [SIXB_CSRF_SECURITY_SCHEME_ID]: [] as string[],
  },
]

export const SIXB_BEARER_SECURITY_REQUIREMENT = [
  {
    [SIXB_BEARER_SECURITY_SCHEME_ID]: [] as string[],
  },
]

export const SIXB_CSRF_OR_BEARER_SECURITY_REQUIREMENT = [
  ...SIXB_CSRF_SECURITY_REQUIREMENT,
  ...SIXB_BEARER_SECURITY_REQUIREMENT,
]

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

export const SIXB_BEARER_SECURITY_SCHEME = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Sixb access token",
  description:
    "Use a Sixb personal access token or service-account token. Bearer tokens are accepted only on routes that explicitly document this scheme.",
} as const

export const SIXB_SHARED_GRANT_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: SHARED_ACCESS_GRANT_HEADER_NAME,
  description:
    "Selects the shared grant whose grant-specific HttpOnly session cookie must authenticate the request.",
} as const
