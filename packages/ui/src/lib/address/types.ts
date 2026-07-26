/**
 * Provider-agnostic address lookup contract.
 *
 * Deliberately free of React and DOM-framework imports so the same providers can
 * be reused outside the browser (server-side geocoding, scripts, tests).
 */

export type AddressCoordinates = {
  readonly latitude: number
  readonly longitude: number
}

/**
 * A single address candidate, normalized across providers.
 *
 * The shape is a superset on purpose: `region` keeps the provider's spelling
 * ("New York") while `regionCode` carries the short form ("NY"), so apps that
 * store either one never lose information.
 */
export type AddressSuggestion = {
  /** Stable within a provider; prefixed with the provider id to stay unique across them. */
  readonly id: string
  /** Primary display line — the "what" (place name and/or street address). */
  readonly label: string
  /** Secondary display line — the "where" (city, region, postal code, country). */
  readonly description: string | null
  /** Place or business name, only when it differs from `line1`. */
  readonly name: string | null
  /** Street address: house number and street, or the place name when there is no street. */
  readonly line1: string | null
  readonly city: string | null
  /** Region as the provider spells it, e.g. "New York". */
  readonly region: string | null
  /** Short region code when it can be derived, e.g. "NY". */
  readonly regionCode: string | null
  readonly county: string | null
  readonly postalCode: string | null
  readonly country: string | null
  /** ISO 3166-1 alpha-2, uppercased. */
  readonly countryCode: string | null
  readonly latitude: number | null
  readonly longitude: number | null
  /** Id of the provider that produced this suggestion. */
  readonly provider: string
  /** Untouched provider payload, for app-specific enrichment. */
  readonly raw: unknown
  /**
   * Set when the provider returned a prediction that still needs
   * {@link AddressProvider.retrieve} to fill in components and coordinates
   * (Google Places and Mapbox work this way; Photon does not).
   */
  readonly partial?: boolean
}

export type AddressSearchOptions = {
  readonly signal?: AbortSignal
  readonly limit?: number
  /** Preferred language for returned names, e.g. "en". */
  readonly lang?: string
  /** Restrict results to these ISO 3166-1 alpha-2 country codes. */
  readonly countries?: readonly string[]
  /** Bias results toward a point. */
  readonly proximity?: AddressCoordinates
  /** Bias/restrict results to a bounding box: [minLon, minLat, maxLon, maxLat]. */
  readonly bbox?: readonly [number, number, number, number]
  /**
   * Groups the keystrokes of one lookup with the follow-up `retrieve` call.
   * Providers that bill per session (Google Places, Mapbox) need this; others ignore it.
   */
  readonly sessionToken?: string
}

export type AddressRetrieveOptions = {
  readonly signal?: AbortSignal
  readonly lang?: string
  readonly sessionToken?: string
}

export type AddressReverseOptions = {
  readonly signal?: AbortSignal
  readonly lang?: string
}

/**
 * Implemented once per geocoding backend. Only `id` and `search` are required;
 * the optional members exist so providers with richer flows (a details call, a
 * billing session, reverse geocoding) can be added without changing call sites.
 */
export type AddressProvider = {
  readonly id: string
  /** Rendered next to results when the data license requires credit. */
  readonly attribution?: string
  /** Text query to address candidates. */
  search(query: string, options?: AddressSearchOptions): Promise<readonly AddressSuggestion[]>
  /**
   * Resolves a `partial` suggestion into a complete one. Providers whose search
   * already returns full addresses omit this.
   */
  retrieve?(
    suggestion: AddressSuggestion,
    options?: AddressRetrieveOptions
  ): Promise<AddressSuggestion>
  /** Coordinates to the address at that point. */
  reverse?(
    coordinates: AddressCoordinates,
    options?: AddressReverseOptions
  ): Promise<AddressSuggestion | null>
  /** Mints a session token for providers that bill per lookup session. */
  createSession?(): string
}

/**
 * Editable address form state. `line2` is never returned by geocoders — it is
 * always user-entered — so it lives here rather than on {@link AddressSuggestion}.
 */
export type AddressDraft = {
  line1: string
  line2: string
  city: string
  region: string
  postalCode: string
  countryCode: string
}
