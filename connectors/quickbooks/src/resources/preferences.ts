import { readEntity } from "../query"
import type { QuickBooksPreferences } from "../types/entities"
import type { QuickBooksPreferencesUpdate, QuickBooksWriteOptions } from "../types/writes"
import { type QuickBooksWriteHttp, updateEntity } from "../write"

export interface QuickBooksPreferencesResource {
  /** Sparse update of supported groups; sales-form preference writes are excluded. */
  update(
    input: QuickBooksPreferencesUpdate,
    options?: QuickBooksWriteOptions
  ): Promise<QuickBooksPreferences>
  /** GET /v3/company/{realmId}/preferences */
  get(): Promise<QuickBooksPreferences>
}

export function createPreferencesResource(
  http: QuickBooksWriteHttp
): QuickBooksPreferencesResource {
  return {
    get: () => readEntity(http, "Preferences", "preferences"),
    async update(input, options) {
      if ("SalesFormsPrefs" in input || "OtherPrefs" in input)
        throw new Error(
          "[SixbQuickBooks] SalesFormsPrefs and OtherPrefs writes are not supported; Intuit can clear settings it will not restore."
        )
      return updateEntity(http, "Preferences", input, options)
    },
  }
}
