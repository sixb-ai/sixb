import { describe, expect, test } from "bun:test"
import {
  addressDraftFromSuggestion,
  createPhotonProvider,
  EMPTY_ADDRESS_DRAFT,
  formatAddress,
  formatAddressLine,
  PHOTON_ATTRIBUTION,
  photonFeatureToSuggestion,
} from "@sixb/ui/lib/address"

const OFFICE_FEATURE = {
  geometry: { coordinates: [-73.9442, 40.6782] },
  properties: {
    osm_type: "W",
    osm_id: 42,
    name: "Sixb office",
    housenumber: "123",
    street: "Main Street",
    city: "New York",
    county: "Kings County",
    state: "New York",
    postcode: "10001",
    country: "United States",
    countrycode: "us",
  },
}

describe("photonFeatureToSuggestion", () => {
  test("maps a complete feature onto the canonical shape", () => {
    expect(photonFeatureToSuggestion(OFFICE_FEATURE)).toEqual({
      id: "photon:W:42",
      label: "Sixb office, 123 Main Street",
      description: "New York NY 10001 • Kings County • United States",
      name: "Sixb office",
      line1: "123 Main Street",
      city: "New York",
      region: "New York",
      regionCode: "NY",
      county: "Kings",
      postalCode: "10001",
      country: "United States",
      countryCode: "US",
      latitude: 40.6782,
      longitude: -73.9442,
      provider: "photon",
      raw: OFFICE_FEATURE,
    })
  })

  test("falls back to the feature name and locality when there is no street", () => {
    const suggestion = photonFeatureToSuggestion({
      properties: { name: "Market Square", locality: "Cambridge", countrycode: "GB" },
    })

    expect(suggestion?.line1).toBe("Market Square")
    expect(suggestion?.label).toBe("Market Square")
    // The name is not repeated once it has become the address line.
    expect(suggestion?.name).toBeNull()
    expect(suggestion?.city).toBe("Cambridge")
    expect(suggestion?.countryCode).toBe("GB")
    expect(suggestion?.regionCode).toBeNull()
  })

  test("ignores features that cannot provide an address line", () => {
    expect(photonFeatureToSuggestion({ properties: { city: "Berlin" } })).toBeNull()
    expect(photonFeatureToSuggestion({})).toBeNull()
    expect(photonFeatureToSuggestion(null)).toBeNull()
  })

  test("keeps a county name without its suffix and only re-labels US counties", () => {
    const us = photonFeatureToSuggestion(OFFICE_FEATURE)
    expect(us?.county).toBe("Kings")
    expect(us?.description).toContain("Kings County")

    const nonUs = photonFeatureToSuggestion({
      properties: { street: "Hauptstraße", county: "Landkreis Rosenheim", countrycode: "de" },
    })
    expect(nonUs?.county).toBe("Landkreis Rosenheim")
    expect(nonUs?.description).toBe("Landkreis Rosenheim")
  })

  test("falls back to coordinates for the id when OSM identifiers are absent", () => {
    const suggestion = photonFeatureToSuggestion({
      geometry: { coordinates: [-0.1276, 51.5072] },
      properties: { name: "Market Square" },
    })
    expect(suggestion?.id).toBe("photon:-0.1276,51.5072:Market Square")
  })
})

describe("region codes", () => {
  function suggestionForState(state: string | undefined) {
    return photonFeatureToSuggestion({ properties: { street: "Main Street", state } })
  }

  test("derives US state codes, passes existing codes through, and rejects the rest", () => {
    expect(suggestionForState("New York")?.regionCode).toBe("NY")
    expect(suggestionForState("district of columbia")?.regionCode).toBe("DC")
    expect(suggestionForState("ny")?.regionCode).toBe("NY")
    expect(suggestionForState("Bavaria")?.regionCode).toBeNull()
    expect(suggestionForState("")?.regionCode).toBeNull()
    expect(suggestionForState(undefined)?.regionCode).toBeNull()
  })

  test("keeps the provider spelling on region even when no code can be derived", () => {
    const suggestion = suggestionForState("Bavaria")
    expect(suggestion?.region).toBe("Bavaria")
    expect(suggestion?.regionCode).toBeNull()
  })
})

describe("formatters", () => {
  const suggestion = photonFeatureToSuggestion(OFFICE_FEATURE)

  test("formats a one-line address using the region code", () => {
    expect(formatAddressLine(suggestion!)).toBe("123 Main Street")
    expect(formatAddress(suggestion!)).toBe("123 Main Street, New York NY 10001")
    expect(formatAddress(suggestion!, { includeCountry: true })).toBe(
      "123 Main Street, New York NY 10001, United States"
    )
  })
})

describe("addressDraftFromSuggestion", () => {
  const suggestion = photonFeatureToSuggestion(OFFICE_FEATURE)

  test("stores the region name by default and the code on request", () => {
    expect(addressDraftFromSuggestion(suggestion!).region).toBe("New York")
    expect(addressDraftFromSuggestion(suggestion!, { region: "code" }).region).toBe("NY")
  })

  test("preserves line2 and falls back to previous values", () => {
    const previous = { ...EMPTY_ADDRESS_DRAFT, line2: "Suite 5", city: "Kept", countryCode: "US" }
    const sparse = photonFeatureToSuggestion({ properties: { name: "Market Square" } })

    expect(addressDraftFromSuggestion(sparse!, { previous })).toEqual({
      line1: "Market Square",
      line2: "Suite 5",
      city: "Kept",
      region: "",
      postalCode: "",
      countryCode: "US",
    })
  })
})

describe("createPhotonProvider", () => {
  test("requests the configured endpoint and maps results", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ endpoint: "https://photon.internal/", fetchImpl })

    const results = await provider.search("123 main")

    expect(provider.id).toBe("photon")
    expect(provider.attribution).toBe(PHOTON_ATTRIBUTION)
    expect(results).toHaveLength(1)
    expect(results[0]?.line1).toBe("123 Main Street")
    expect(urls).toHaveLength(1)
    expect(urls[0]).toStartWith("https://photon.internal/api?")
    expect(urls[0]).toContain("q=123+main")
    expect(urls[0]).toContain("limit=5")
    expect(urls[0]).toContain("lang=en")
  })

  test("passes proximity, bbox, and limit through to Photon", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [] })
    const provider = createPhotonProvider({ fetchImpl })

    await provider.search("main", {
      limit: 8,
      lang: "de",
      proximity: { latitude: 40.1, longitude: -73.2 },
      bbox: [-74, 40, -73, 41],
    })

    expect(urls[0]).toContain("limit=8")
    expect(urls[0]).toContain("lang=de")
    expect(urls[0]).toContain("lat=40.1")
    expect(urls[0]).toContain("lon=-73.2")
    expect(urls[0]).toContain("bbox=-74%2C40%2C-73%2C41")
  })

  test("returns no results for a blank query without calling the network", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ fetchImpl })

    expect(await provider.search("   ")).toEqual([])
    expect(urls).toHaveLength(0)
  })

  test("caches repeated queries", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ fetchImpl })

    await provider.search("123 main")
    await provider.search("123 main")

    expect(urls).toHaveLength(1)
  })

  test("honours a disabled cache", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ fetchImpl, cacheTtlMs: 0 })

    await provider.search("123 main")
    await provider.search("123 main")

    expect(urls).toHaveLength(2)
  })

  test("coalesces concurrent identical queries into one request", async () => {
    const { fetchImpl, urls, release } = stubFetch({ features: [OFFICE_FEATURE] }, { defer: true })
    const provider = createPhotonProvider({ fetchImpl })

    const both = Promise.all([provider.search("123 main"), provider.search("123 main")])
    release()
    const [first, second] = await both

    expect(urls).toHaveLength(1)
    expect(first).toEqual(second)
  })

  test("filters results to the requested countries", async () => {
    const { fetchImpl } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ fetchImpl })

    expect(await provider.search("123 main", { countries: ["GB"] })).toEqual([])
    expect(await provider.search("123 main", { countries: ["us"] })).toHaveLength(1)
  })

  test("rejects an aborted caller without discarding the shared response", async () => {
    const { fetchImpl, urls, release } = stubFetch({ features: [OFFICE_FEATURE] }, { defer: true })
    const provider = createPhotonProvider({ fetchImpl })
    const controller = new AbortController()

    const aborted = provider.search("123 main", { signal: controller.signal })
    controller.abort()
    release()

    expect(await abortNameOf(aborted)).toBe("AbortError")

    // The in-flight request still completed and populated the cache.
    await Bun.sleep(20)
    expect(await provider.search("123 main")).toHaveLength(1)
    expect(urls).toHaveLength(1)
  })

  test("rejects without a request when the signal is already aborted", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ fetchImpl })

    const aborted = provider.search("123 main", { signal: AbortSignal.abort() })

    expect(await abortNameOf(aborted)).toBe("AbortError")
    expect(urls).toHaveLength(0)
  })

  test("throws a package-prefixed error for a failed response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    const provider = createPhotonProvider({ fetchImpl })

    await expect(provider.search("123 main")).rejects.toThrow(
      "[SixbUI] Photon address lookup failed (503)."
    )
  })

  test("reverse geocodes coordinates to a single suggestion", async () => {
    const { fetchImpl, urls } = stubFetch({ features: [OFFICE_FEATURE] })
    const provider = createPhotonProvider({ fetchImpl })

    const suggestion = await provider.reverse?.({ latitude: 40.6782, longitude: -73.9442 })

    expect(suggestion?.line1).toBe("123 Main Street")
    expect(urls[0]).toStartWith("https://photon.komoot.io/reverse?")
    expect(urls[0]).toContain("lat=40.6782")
    expect(urls[0]).toContain("lon=-73.9442")
  })

  test("reverse returns null when Photon has no match", async () => {
    const { fetchImpl } = stubFetch({ features: [] })
    const provider = createPhotonProvider({ fetchImpl })

    expect(await provider.reverse?.({ latitude: 0, longitude: 0 })).toBeNull()
  })

  test("has no retrieve or session step", () => {
    const provider = createPhotonProvider()
    expect(provider.retrieve).toBeUndefined()
    expect(provider.createSession).toBeUndefined()
  })
})

/** Resolves to the rejection's `name`, so DOMException identity is asserted directly. */
async function abortNameOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof DOMException ? error.name : null
  }
}

/** Records requested URLs and returns a fixed payload, optionally on demand. */
function stubFetch(
  payload: unknown,
  options: { readonly defer?: boolean } = {}
): { fetchImpl: typeof fetch; urls: string[]; release: () => void } {
  const urls: string[] = []
  let release = () => {}
  const gate = options.defer
    ? new Promise<void>((resolve) => {
        release = resolve
      })
    : Promise.resolve()

  const fetchImpl = (async (input: URL | RequestInfo) => {
    urls.push(String(input))
    await gate
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, urls, release: () => release() }
}
