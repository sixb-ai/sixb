import { CSRF_HEADER_NAME, DEFAULT_CSRF_COOKIE_NAME } from "@pario/core"

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
  description: `Required for authenticated mutating requests. Copy the value from the ${DEFAULT_CSRF_COOKIE_NAME} cookie.`,
} as const
