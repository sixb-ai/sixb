import { type QuickBooksReadHttp, readEntity } from "../query"
import type { QuickBooksPreferences } from "../types/entities"

export interface QuickBooksPreferencesResource {
  /** GET /v3/company/{realmId}/preferences */
  get(): Promise<QuickBooksPreferences>
}

export function createPreferencesResource(http: QuickBooksReadHttp): QuickBooksPreferencesResource {
  return { get: () => readEntity(http, "Preferences", "preferences") }
}
