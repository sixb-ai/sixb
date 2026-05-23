import { CSRF_HEADER_NAME } from "@pario/core"

export const PARIO_CSRF_SECURITY_SCHEME_ID = "parioCsrf"

export const PARIO_CSRF_SECURITY_REQUIREMENT = [
  {
    [PARIO_CSRF_SECURITY_SCHEME_ID]: [] as string[],
  },
]

export const PARIO_CSRF_SECURITY_SCHEME = {
  type: "apiKey",
  in: "header",
  name: CSRF_HEADER_NAME,
  description:
    "Required for authenticated mutating requests. Use the csrfToken returned by GET /api/auth/session.",
} as const
