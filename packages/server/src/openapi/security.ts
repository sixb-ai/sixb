import { CSRF_HEADER_NAME } from "@sixb/core"

export const SIXB_CSRF_SECURITY_SCHEME_ID = "sixbCsrf"

export const SIXB_CSRF_SECURITY_REQUIREMENT = [
  {
    [SIXB_CSRF_SECURITY_SCHEME_ID]: [] as string[],
  },
]

export const SIXB_CSRF_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: CSRF_HEADER_NAME,
  description:
    "Required for authenticated mutating requests. Use the csrfToken returned by GET /api/auth/session.",
} as const
