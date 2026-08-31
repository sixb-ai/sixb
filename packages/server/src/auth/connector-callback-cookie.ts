import { getCookie } from "@sixb/core/internal/auth"
import { createSixbError } from "@sixb/core/internal/errors"

const CALLBACK_PATH = "/auth/connectors/callback"
const COOKIE_PREFIX = "sixb_connector_callback_"
const ATTEMPT_ID_PATTERN =
  /^cat_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function createConnectorCallbackCookie(input: {
  readonly request: Request
  readonly attemptId: string
  readonly secret: string
  readonly expiresAt: Date
}): string {
  const expiresAt = validDate(input.expiresAt)
  return serializeConnectorCallbackCookie({
    request: input.request,
    name: connectorCallbackCookieName(input.attemptId),
    value: input.secret,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    expiresAt,
  })
}

export function readConnectorCallbackCookie(
  request: Request,
  state: string
): { readonly name: string; readonly value: string | undefined } {
  const name = connectorCallbackCookieName(attemptIdFromState(state))
  return { name, value: getCookie(request, name) }
}

export function clearConnectorCallbackCookie(request: Request, name: string): string {
  return serializeConnectorCallbackCookie({
    request,
    name,
    value: "",
    maxAge: 0,
    expiresAt: new Date(0),
  })
}

function attemptIdFromState(state: string): string {
  const separator = state.indexOf(".")
  if (separator <= 0 || separator === state.length - 1) {
    throw createSixbError(
      "connector.authorization_invalid",
      "[SixbServer] Connector OAuth state is invalid."
    )
  }
  return state.slice(0, separator)
}

function connectorCallbackCookieName(attemptId: string): string {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw createSixbError(
      "connector.authorization_invalid",
      "[SixbServer] Connector OAuth attempt id is invalid."
    )
  }
  return `${COOKIE_PREFIX}${attemptId}`
}

function serializeConnectorCallbackCookie(input: {
  readonly request: Request
  readonly name: string
  readonly value: string
  readonly maxAge: number
  readonly expiresAt: Date
}): string {
  const parts = [
    `${input.name}=${input.value}`,
    `Path=${CALLBACK_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.trunc(input.maxAge)}`,
    `Expires=${input.expiresAt.toUTCString()}`,
  ]
  if (shouldUseSecureCookie(input.request)) parts.push("Secure")
  return parts.join("; ")
}

function shouldUseSecureCookie(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || process.env.NODE_ENV === "production"
}

function validDate(value: Date): Date {
  if (Number.isNaN(value.getTime())) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbServer] Connector callback cookie expiration is invalid."
    )
  }
  return new Date(value)
}
