import type { ActivityAttribution } from "./activity-tracker"

const MAX_AGE_MS = 30 * 60_000
const MAX_STORED_LENGTH = 2_048
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/
const UTM_KEYS = ["source", "medium", "campaign"] as const
const ATTRIBUTION_KEYS = [...UTM_KEYS, "referrer"] as const

type ArrivalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">
type MutableAttribution = { -readonly [Key in keyof ActivityAttribution]: ActivityAttribution[Key] }

/**
 * How a document was reached: its UTM labels, else the external host that referred it, else `{}`
 * for direct. `undefined` when the campaign labels are malformed: not collected, rather than a
 * direct arrival it was not. Never a browsing URL.
 */
export function readActivityAttribution(
  href: string,
  referrer: string,
  apiBaseUrl: string
): ActivityAttribution | undefined {
  const url = new URL(href)

  const utm: MutableAttribution = {}
  let malformed = false
  for (const key of UTM_KEYS) {
    const raw = url.searchParams.get(`utm_${key}`)
    const value = label(raw)
    if (value !== undefined) {
      utm[key] = value
    } else if (raw?.trim()) {
      malformed = true
    }
  }

  if (Object.keys(utm).length > 0) {
    return utm
  }
  if (malformed) {
    return undefined
  }

  return externalReferrer(referrer, [url.hostname, new URL(apiBaseUrl).hostname])
}

/**
 * A short-lived, per-tab handoff across Sixb's own redirects, such as sign-in. It holds the
 * arrival only: no event, route or identity.
 */
export class ActivityArrival {
  attribution: ActivityAttribution | undefined

  constructor(
    private readonly storage: ArrivalStorage | null,
    private readonly key: string,
    current: ActivityAttribution | undefined,
    private readonly now: () => number = Date.now
  ) {
    const pending = this.takePending()
    const hasCampaign = UTM_KEYS.some((key) => current?.[key] !== undefined)
    // A fresh campaign wins; otherwise the arrival from before the redirect does.
    this.attribution = hasCampaign ? current : (pending ?? current)
  }

  preserve(): void {
    if (this.attribution === undefined) {
      return
    }

    try {
      this.storage?.setItem(
        this.key,
        JSON.stringify({ at: this.now(), attribution: this.attribution })
      )
    } catch {
      // Without sessionStorage, URL UTMs still survive the normal returnTo flow.
    }
  }

  private takePending(): ActivityAttribution | undefined {
    try {
      const raw = this.storage?.getItem(this.key)
      this.storage?.removeItem(this.key)
      if (!raw || raw.length > MAX_STORED_LENGTH) {
        return undefined
      }

      const value: unknown = JSON.parse(raw)
      if (
        !value ||
        typeof value !== "object" ||
        !("at" in value) ||
        !("attribution" in value) ||
        typeof value.at !== "number"
      ) {
        return undefined
      }

      const age = this.now() - value.at
      return age >= 0 && age < MAX_AGE_MS ? storedAttribution(value.attribution) : undefined
    } catch {
      // Storage restrictions must never interfere with sign-in or the app itself.
      return undefined
    }
  }
}

let arrival: ActivityArrival | undefined

/** Reads this document's arrival, for the authority `scope` the client is configured for. */
export function prepareActivityArrival(apiBaseUrl: string, scope: string): void {
  arrival = undefined
  if (typeof window === "undefined") {
    return
  }

  let storage: ArrivalStorage | null = null
  try {
    storage = window.sessionStorage
  } catch {
    // Storage may be blocked.
  }

  try {
    arrival = new ActivityArrival(
      storage,
      `sixb:activity-arrival:${JSON.stringify([apiBaseUrl, scope])}`,
      readActivityAttribution(window.location.href, document.referrer, apiBaseUrl)
    )
  } catch {
    // Outside a browser there may be no usable location.
  }
}

/** Keeps the arrival across a Sixb redirect that replaces this document. */
export function preserveSixbActivityArrival(): void {
  arrival?.preserve()
}

export function takeActivityArrival(): ActivityAttribution | undefined {
  const value = arrival?.attribution
  // A later redirect from this document continues the visit; it is not another arrival.
  if (arrival) {
    arrival.attribution = {}
  }
  return value
}

export function clearActivityArrival(): void {
  arrival = undefined
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const text = value.trim()
  return text && text.length <= 100 && !CONTROL_CHARACTERS.test(text) ? text : undefined
}

function externalReferrer(referrer: string, ownHosts: readonly string[]): ActivityAttribution {
  try {
    const previous = new URL(referrer)
    const hostname = previous.hostname
    if (
      (previous.protocol === "http:" || previous.protocol === "https:") &&
      !ownHosts.includes(hostname) &&
      hostname.length <= 253 &&
      HOSTNAME.test(hostname)
    ) {
      return { referrer: hostname }
    }
  } catch {
    // Browsers may send no referrer. Direct means no usable source is available.
  }
  return {}
}

/** Stored data is untrusted: anything but the exact attribution shape is dropped. */
function storedAttribution(value: unknown): ActivityAttribution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  if (Object.keys(value).some((key) => !ATTRIBUTION_KEYS.some((field) => field === key))) {
    return undefined
  }

  const result: MutableAttribution = {}
  for (const key of ATTRIBUTION_KEYS) {
    const raw: unknown = Reflect.get(value, key)
    if (raw === undefined) {
      continue
    }
    if (typeof raw !== "string") {
      return undefined
    }

    const valid =
      key === "referrer"
        ? raw.length > 0 && raw.length <= 253 && HOSTNAME.test(raw)
        : label(raw) === raw
    if (!valid) {
      return undefined
    }
    result[key] = raw
  }

  return result
}
