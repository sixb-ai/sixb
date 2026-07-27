import { API_CONSTANTS } from "./types"

const APP_STORE_LOOKUP_URL = "https://itunes.apple.com/lookup?id=1348640525"
const APP_VERSION_PATTERN = /^\d+(?:\.\d+){2}$/

interface AppStoreLookupResponse {
  readonly results?: readonly { readonly version?: unknown }[]
}

export interface ResolvePanasonicAppVersionOptions {
  readonly override?: string
  readonly signal?: AbortSignal
  readonly fetch?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

/** Resolve the exact app version accepted by the Comfort Cloud API. */
export async function resolvePanasonicAppVersion(
  options: ResolvePanasonicAppVersionOptions = {}
): Promise<string> {
  const override = options.override?.trim()
  if (override) {
    assertAppVersion(override, "PANASONIC_APP_VERSION")
    return override
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 5_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  try {
    const response = await (options.fetch ?? globalThis.fetch)(APP_STORE_LOOKUP_URL, { signal })
    if (!response.ok) {
      return API_CONSTANTS.APP_VERSION
    }

    const payload = (await response.json()) as AppStoreLookupResponse
    const version = payload.results?.[0]?.version
    if (typeof version !== "string" || !APP_VERSION_PATTERN.test(version)) {
      return API_CONSTANTS.APP_VERSION
    }

    return version
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    return API_CONSTANTS.APP_VERSION
  }
}

function assertAppVersion(version: string, source: string): void {
  if (!APP_VERSION_PATTERN.test(version)) {
    throw new Error(`[Panasonic] ${source} must use the x.y.z format, received '${version}'.`)
  }
}
