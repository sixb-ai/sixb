import { CSRF_HEADER_NAME } from "@sixb/core"

export const SIXB_CSRF_SECURITY_SCHEME_ID = "sixbCsrf"
export const SIXB_BEARER_SECURITY_SCHEME_ID = "sixbBearer"

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

export const SIXB_CSRF_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: CSRF_HEADER_NAME,
  description:
    "Required for authenticated mutating requests. Use the csrfToken returned by GET /api/auth/session.",
} as const

export const SIXB_BEARER_SECURITY_SCHEME = {
  type: "http",
  scheme: "bearer",
  bearerFormat: "Sixb access token",
  description:
    "Use a Sixb personal access token or service-account token. Bearer tokens are accepted only on routes that explicitly document this scheme.",
} as const
