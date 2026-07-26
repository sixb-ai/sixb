import type { AddressDraft, AddressSuggestion } from "./types"

/** Trims a possibly-unknown value into a non-empty string, or null. */
export function addressText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** Joins parts with a single space, dropping blanks. */
export function joinSpace(...values: Array<string | null | undefined>): string | null {
  const parts = values.map((value) => value?.trim()).filter((value): value is string => !!value)
  return parts.length ? parts.join(" ") : null
}

/** Joins parts with `separator`, dropping blanks. */
export function joinParts(
  separator: string,
  ...values: Array<string | null | undefined>
): string | null {
  const parts = values.map((value) => value?.trim()).filter((value): value is string => !!value)
  return parts.length ? parts.join(separator) : null
}

/** The street line to put in an address form's first field. */
export function formatAddressLine(suggestion: AddressSuggestion): string {
  return suggestion.line1 ?? suggestion.name ?? ""
}

/**
 * Renders a suggestion as a single-line address, e.g.
 * `"123 Main Street, Brooklyn NY 11201"`.
 */
export function formatAddress(
  suggestion: AddressSuggestion,
  options: { readonly includeCountry?: boolean } = {}
): string {
  const locality = joinSpace(
    suggestion.city,
    suggestion.regionCode ?? suggestion.region,
    suggestion.postalCode
  )
  return (
    joinParts(
      ", ",
      formatAddressLine(suggestion),
      locality,
      options.includeCountry ? suggestion.country : null
    ) ?? ""
  )
}

export const EMPTY_ADDRESS_DRAFT: AddressDraft = {
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  countryCode: "",
}

/**
 * Projects a suggestion onto address form state.
 *
 * Fields the suggestion does not carry fall back to `previous` rather than being
 * blanked, and `line2` is always preserved because no geocoder returns it.
 * Pass `region: "code"` to store short region codes ("NY") instead of the
 * provider's spelling ("New York").
 */
export function addressDraftFromSuggestion(
  suggestion: AddressSuggestion,
  options: { readonly previous?: AddressDraft; readonly region?: "name" | "code" } = {}
): AddressDraft {
  const previous = options.previous ?? EMPTY_ADDRESS_DRAFT
  const region =
    options.region === "code"
      ? (suggestion.regionCode ?? suggestion.region)
      : (suggestion.region ?? suggestion.regionCode)

  return {
    line1: suggestion.line1 ?? suggestion.name ?? previous.line1,
    line2: previous.line2,
    city: suggestion.city ?? previous.city,
    region: region ?? previous.region,
    postalCode: suggestion.postalCode ?? previous.postalCode,
    countryCode: suggestion.countryCode ?? previous.countryCode,
  }
}
