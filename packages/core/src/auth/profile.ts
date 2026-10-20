import { AuthRuntimeError } from "./errors"
import type { UpdateOwnProfileInput } from "./types"

const MAX_DISPLAY_NAME_LENGTH = 100
const MAX_AVATAR_URL_LENGTH = 2048

// What a name must not carry: control characters, unpaired surrogates, bidirectional overrides and
// isolates, and line or paragraph separators. Other format characters stay, such as the zero-width
// joiner emoji are built with.
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cs}\u202A-\u202E\u2066-\u2069\u2028\u2029]/u
const VISIBLE_CHARACTER = /[^\p{Z}\p{Cf}]/u

// Plain http only reaches a picture served by the developer's own machine.
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"])

/** Validate the changes a person makes to their own profile. An empty value clears the field. */
export function normalizeProfileChanges(input: UpdateOwnProfileInput): UpdateOwnProfileInput {
  if (input.displayName === undefined && input.avatarUrl === undefined) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Sixb] A profile update needs displayName or avatarUrl."
    )
  }

  const changes: { displayName?: string | null; avatarUrl?: string | null } = {}
  if (input.displayName !== undefined) {
    changes.displayName =
      input.displayName === null ? null : normalizeDisplayName(input.displayName)
  }
  if (input.avatarUrl !== undefined) {
    changes.avatarUrl = input.avatarUrl === null ? null : normalizeAvatarUrl(input.avatarUrl)
  }

  return changes
}

/**
 * A name a sign-in supplies, such as one an identity provider sent, held to the rules a person's own
 * name follows. A value that breaks them counts as not sent, so it never makes a sign-in fail.
 */
export function signInDisplayName(value: unknown): string | undefined {
  const name = typeof value === "string" ? value.trim() : ""
  return name && displayNameProblem(name) === null ? name : undefined
}

/** A picture a sign-in supplies, treated as {@link signInDisplayName} treats a name. */
export function signInAvatarUrl(value: unknown): string | undefined {
  return typeof value === "string" ? (canonicalAvatarUrl(value.trim()) ?? undefined) : undefined
}

function normalizeDisplayName(value: string): string | null {
  const name = value.trim()
  if (!name) {
    return null
  }

  const problem = displayNameProblem(name)
  if (problem) {
    throw new AuthRuntimeError("invalid_auth_input", problem)
  }

  return name
}

function normalizeAvatarUrl(value: string): string | null {
  const url = value.trim()
  if (!url) {
    return null
  }

  const canonical = canonicalAvatarUrl(url)
  if (!canonical) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      `[Sixb] An avatar URL must be an https URL of at most ${MAX_AVATAR_URL_LENGTH} characters, without a user name or password.`
    )
  }

  return canonical
}

// Why a trimmed, non-empty name cannot be used, or null when it can. The limit counts code points,
// so an emoji is one character. A code point is at most two UTF-16 units, so a string longer than
// twice the limit is refused before it is split, which an unauthenticated sign-in could make costly.
function displayNameProblem(name: string): string | null {
  if (name.length > MAX_DISPLAY_NAME_LENGTH * 2 || [...name].length > MAX_DISPLAY_NAME_LENGTH) {
    return `[Sixb] A display name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`
  }

  if (FORBIDDEN_NAME_CHARACTERS.test(name)) {
    return "[Sixb] A display name cannot contain control, bidirectional or line separator characters."
  }

  if (!VISIBLE_CHARACTER.test(name)) {
    return "[Sixb] A display name needs at least one visible character."
  }

  return null
}

// The app loads pictures over https only, so that is all a profile keeps, written as the browser
// would resolve it.
function canonicalAvatarUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  if (!secure || url.username || url.password || url.href.length > MAX_AVATAR_URL_LENGTH) {
    return null
  }

  return url.href
}
