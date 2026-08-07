import type { AceIotPageOptions } from "./types"
import { ACE_IOT_PAGE_SIZE_VALUES, ACE_IOT_PER_PAGE_VALUES } from "./types"

/**
 * Encode one path segment. ACE point names are slash-separated
 * (`client/site/10.0.0.1-100/analogInput/1`), so the slashes must be percent-encoded or the
 * request lands on a different route.
 */
export function pathSegment(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[SixbAceIot] ${field} must be a non-empty string.`)
  }

  return encodeURIComponent(value)
}

export function assertPageOptions(options: AceIotPageOptions | undefined): void {
  if (options?.page !== undefined && (!Number.isInteger(options.page) || options.page < 1)) {
    throw new Error("[SixbAceIot] page must be an integer greater than 0.")
  }

  if (options?.perPage !== undefined) {
    assertPerPage(options.perPage)
  }
}

/**
 * ACE rejects any `per_page` outside its enum with a 400 whose message names the value but not the
 * allowed set. Checking locally spends no request and says what to use instead.
 */
export function assertPerPage(perPage: number): void {
  if (!(ACE_IOT_PER_PAGE_VALUES as readonly number[]).includes(perPage)) {
    throw new Error(
      `[SixbAceIot] perPage must be one of ${ACE_IOT_PER_PAGE_VALUES.join(", ")}. Received ${perPage}.`
    )
  }
}

/** The timeseries endpoint takes a different enum than `per_page`: it allows 3 but not 2. */
export function assertTimeseriesPageSize(pageSize: number): void {
  if (!(ACE_IOT_PAGE_SIZE_VALUES as readonly number[]).includes(pageSize)) {
    throw new Error(
      `[SixbAceIot] pageSize must be one of ${ACE_IOT_PAGE_SIZE_VALUES.join(", ")}. Received ${pageSize}.`
    )
  }
}

export function assertMaxPages(maxPages: number | undefined): void {
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new Error("[SixbAceIot] maxPages must be an integer greater than 0.")
  }
}
