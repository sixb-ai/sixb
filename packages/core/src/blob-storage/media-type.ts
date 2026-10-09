// One media type as RFC 9110 defines it: `type/subtype`, each a token, then optional
// `;name=value` parameters whose value is a token or a quoted string. Stricter than the RFC where
// leniency only invites a second reading: no surrounding whitespace, no empty parameters, no
// escapes, and no comma anywhere. Browsers read a comma-separated value as a list of types and
// use the last valid one, so a value with a comma can mean something other than its first type.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+"
const QUOTED_STRING = '"[\\t\\x20\\x21\\x23-\\x2b\\x2d-\\x5b\\x5d-\\x7e]*"'
const PARAMETER = `[\\t ]*;[\\t ]*(${TOKEN})=(${TOKEN}|${QUOTED_STRING})`
const MEDIA_TYPE_PATTERN = new RegExp(`^(${TOKEN})/(${TOKEN})((?:${PARAMETER})*)$`)
const PARAMETER_PATTERN = new RegExp(PARAMETER, "g")

/**
 * The canonical form of a single well-formed media type, or `null` for anything else.
 *
 * Type, subtype, and parameter names are case-insensitive, so they are lowercased; parameter
 * values keep their case. `"Text/Plain; Charset=UTF-8"` becomes `"text/plain;charset=UTF-8"`.
 */
export function canonicalMediaType(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = MEDIA_TYPE_PATTERN.exec(value)
  if (!match) return null

  const [, type, subtype, parameters] = match
  let canonical = `${type.toLowerCase()}/${subtype.toLowerCase()}`
  for (const [, name, parameterValue] of parameters.matchAll(PARAMETER_PATTERN)) {
    canonical += `;${name.toLowerCase()}=${parameterValue}`
  }
  return canonical
}
