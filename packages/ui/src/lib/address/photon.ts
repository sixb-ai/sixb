import { addressText, joinParts, joinSpace } from "./format"
import type {
  AddressCoordinates,
  AddressProvider,
  AddressReverseOptions,
  AddressSearchOptions,
  AddressSuggestion,
} from "./types"

const PHOTON_PROVIDER_ID = "photon"

/** Photon serves OpenStreetMap data, which is ODbL-licensed and requires credit. */
export const PHOTON_ATTRIBUTION = "Address data © OpenStreetMap contributors"

const DEFAULT_ENDPOINT = "https://photon.komoot.io"
const DEFAULT_LIMIT = 5
const DEFAULT_LANG = "en"
const DEFAULT_TIMEOUT_MS = 6_000
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000

export type PhotonProviderOptions = {
  /**
   * Base URL of a Photon instance; `/api` and `/reverse` are appended.
   * Point this at a self-hosted instance — the public one is best-effort with no SLA.
   */
  readonly endpoint?: string
  readonly limit?: number
  readonly lang?: string
  readonly countries?: readonly string[]
  readonly proximity?: AddressCoordinates
  readonly bbox?: readonly [number, number, number, number]
  readonly timeoutMs?: number
  /** Set to 0 to disable response caching. */
  readonly cacheTtlMs?: number
  readonly fetchImpl?: typeof fetch
}

/**
 * Photon address provider — free, keyless, and self-hostable.
 *
 * Photon returns complete addresses from a single request, so this provider has
 * no `retrieve` or `createSession`.
 */
export function createPhotonProvider(options: PhotonProviderOptions = {}): AddressProvider {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const fetchImpl = options.fetchImpl ?? fetch

  const cache = new Map<string, { at: number; suggestions: readonly AddressSuggestion[] }>()
  const inflight = new Map<string, Promise<readonly AddressSuggestion[]>>()

  async function request(url: URL): Promise<readonly AddressSuggestion[]> {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) {
      throw new Error(`[SixbUI] Photon address lookup failed (${response.status}).`)
    }
    const payload: unknown = await response.json()
    const features = record(payload)?.features
    if (!Array.isArray(features)) return []
    return features
      .map(photonFeatureToSuggestion)
      .filter((suggestion): suggestion is AddressSuggestion => suggestion !== null)
  }

  /**
   * Shares one network request between concurrent callers and caches the result.
   * The caller's signal is applied to their own promise rather than the shared
   * request, so one caller aborting (a keystroke superseding another) neither
   * fails the others nor discards a response that is about to be cached.
   */
  async function cachedRequest(
    key: string,
    url: URL,
    signal: AbortSignal | undefined
  ): Promise<readonly AddressSuggestion[]> {
    if (signal?.aborted) throw abortError()

    const cached = cacheTtlMs > 0 ? cache.get(key) : undefined
    if (cached && Date.now() - cached.at < cacheTtlMs) return cached.suggestions

    let pending = inflight.get(key)
    if (!pending) {
      pending = request(url).then((suggestions) => {
        if (cacheTtlMs > 0) cache.set(key, { at: Date.now(), suggestions })
        return suggestions
      })
      inflight.set(key, pending)
      const settled = pending
      void settled
        .catch(() => {})
        .then(() => {
          if (inflight.get(key) === settled) inflight.delete(key)
        })
    }

    return withAbort(pending, signal)
  }

  return {
    id: PHOTON_PROVIDER_ID,
    attribution: PHOTON_ATTRIBUTION,

    async search(query, searchOptions: AddressSearchOptions = {}) {
      const trimmed = query.trim()
      if (!trimmed) return []

      const limit = searchOptions.limit ?? options.limit ?? DEFAULT_LIMIT
      const lang = searchOptions.lang ?? options.lang ?? DEFAULT_LANG
      const proximity = searchOptions.proximity ?? options.proximity
      const bbox = searchOptions.bbox ?? options.bbox

      const url = new URL(`${endpoint}/api`)
      url.searchParams.set("q", trimmed)
      url.searchParams.set("limit", String(limit))
      url.searchParams.set("lang", lang)
      if (proximity) {
        url.searchParams.set("lat", String(proximity.latitude))
        url.searchParams.set("lon", String(proximity.longitude))
      }
      if (bbox) url.searchParams.set("bbox", bbox.join(","))

      // Photon has no country parameter, so the restriction is applied to results.
      // The cache key omits it, letting differently-restricted callers share a request.
      const suggestions = await cachedRequest(
        `search:${trimmed.toLowerCase()}:${url.search}`,
        url,
        searchOptions.signal
      )
      return filterByCountry(suggestions, searchOptions.countries ?? options.countries)
    },

    async reverse(coordinates, reverseOptions: AddressReverseOptions = {}) {
      const url = new URL(`${endpoint}/reverse`)
      url.searchParams.set("lat", String(coordinates.latitude))
      url.searchParams.set("lon", String(coordinates.longitude))
      url.searchParams.set("lang", reverseOptions.lang ?? options.lang ?? DEFAULT_LANG)
      url.searchParams.set("limit", "1")

      const suggestions = await cachedRequest(`reverse:${url.search}`, url, reverseOptions.signal)
      return suggestions[0] ?? null
    },
  }
}

/**
 * Maps one Photon GeoJSON feature onto the canonical suggestion shape.
 *
 * Returns null for features with no addressable line (a bare city or country),
 * which are noise in an address field.
 */
export function photonFeatureToSuggestion(feature: unknown): AddressSuggestion | null {
  const properties = record(record(feature)?.properties)
  if (!properties) return null

  const name = addressText(properties.name)
  const street = joinSpace(addressText(properties.housenumber), addressText(properties.street))
  const line1 = street ?? name
  if (!line1) return null

  const city =
    addressText(properties.city) ??
    addressText(properties.town) ??
    addressText(properties.village) ??
    addressText(properties.locality) ??
    addressText(properties.municipality) ??
    addressText(properties.district)
  const region = addressText(properties.state)
  const regionCode = toRegionCode(region)
  const county = stripCountySuffix(addressText(properties.county))
  const postalCode = addressText(properties.postcode)
  const country = addressText(properties.country)
  const countryCode = addressText(properties.countrycode)?.toUpperCase() ?? null

  const coordinates = record(record(feature)?.geometry)?.coordinates
  const longitude = Array.isArray(coordinates) ? numeric(coordinates[0]) : null
  const latitude = Array.isArray(coordinates) ? numeric(coordinates[1]) : null

  const displayName = name && name !== line1 ? name : null
  const label = joinParts(", ", displayName, line1) ?? line1
  const description = joinParts(
    " • ",
    joinSpace(city, regionCode ?? region, postalCode),
    // Photon spells US counties with the suffix; other countries use their own term.
    county && countryCode === "US" ? `${county} County` : county,
    country
  )

  const osmType = addressText(properties.osm_type)
  const osmId = numeric(properties.osm_id)
  const identity =
    osmType && osmId !== null
      ? `${osmType}:${osmId}`
      : `${longitude ?? "x"},${latitude ?? "y"}:${label}`

  return {
    id: `${PHOTON_PROVIDER_ID}:${identity}`,
    label,
    description,
    name: displayName,
    line1,
    city,
    region,
    regionCode,
    county,
    postalCode,
    country,
    countryCode,
    latitude,
    longitude,
    provider: PHOTON_PROVIDER_ID,
    raw: feature,
  }
}

function filterByCountry(
  suggestions: readonly AddressSuggestion[],
  countries: readonly string[] | undefined
): readonly AddressSuggestion[] {
  if (!countries?.length) return suggestions
  const allowed = new Set(countries.map((code) => code.trim().toUpperCase()))
  return suggestions.filter(
    (suggestion) => suggestion.countryCode !== null && allowed.has(suggestion.countryCode)
  )
}

/** Rejects as soon as `signal` aborts, without disturbing the shared request. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function abortError(): DOMException {
  return new DOMException("The address lookup was aborted.", "AbortError")
}

/**
 * Derives a short region code from Photon's region name.
 *
 * Photon reports US states as full names ("New York") and exposes no ISO 3166-2
 * code, so the mapping lives here rather than in the shared formatters. Keyed
 * providers return codes directly — Google Places as
 * `administrative_area_level_1.short_name`, Mapbox as `short_code` — and should
 * use those instead of this table.
 *
 * Returns null when the value cannot be mapped, so callers never mistake a full
 * region name for a code; the raw value stays on `AddressSuggestion.region`.
 */
function toRegionCode(value: string | null | undefined): string | null {
  const region = value?.trim()
  if (!region) return null
  if (/^[a-z]{2}$/i.test(region)) return region.toUpperCase()
  return US_STATE_CODES[region.toLowerCase()] ?? null
}

function stripCountySuffix(value: string | null): string | null {
  return value?.replace(/\s+county$/i, "").trim() || null
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

const US_STATE_CODES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "puerto rico": "PR",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
}
