/**
 * The origin the API is reachable at from outside, for features that hand out absolute URLs a
 * third party will fetch. It is deployment topology, not app configuration: the API server
 * records the `publicOrigin` it was started with, and the CLI records `SIXB_API_PUBLIC_ORIGIN`
 * for worker processes. A process that never learns it cannot issue such URLs.
 */

const apiPublicOrigins = new WeakMap<object, string>()

/** Record where the API is reachable. A host served by several servers keeps the latest one. */
export function setApiPublicOrigin(host: object, origin: string): void {
  apiPublicOrigins.set(host, normalizeOrigin(origin))
}

export function getApiPublicOrigin(host: object): string | undefined {
  return apiPublicOrigins.get(host)
}

function normalizeOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[Sixb] Invalid API public origin: '${value}'.`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("[Sixb] The API public origin must use http or https.")
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("[Sixb] The API public origin must be an origin, not a full URL.")
  }
  return url.origin
}
