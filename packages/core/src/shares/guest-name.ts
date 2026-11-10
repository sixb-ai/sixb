/** The longest name a shared link's visitor may give, in characters. */
export const GUEST_NAME_MAX_LENGTH = 60

/**
 * Control characters, line and paragraph separators, and the marks that turn text around: any of
 * them could make a guest's name read as something else beside a member's.
 */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}‎‏‪-‮⁦-⁩]/u

/**
 * The name a shared link's visitor gives, as it is kept: on one line, its spaces collapsed, 1 to
 * {@link GUEST_NAME_MAX_LENGTH} characters. `null` for one that will not do.
 */
export function guestName(value: unknown): string | null {
  if (typeof value !== "string" || UNSAFE_CHARACTERS.test(value)) return null

  const name = value.normalize("NFC").replace(/\s+/g, " ").trim()
  const length = [...name].length
  return length > 0 && length <= GUEST_NAME_MAX_LENGTH ? name : null
}
