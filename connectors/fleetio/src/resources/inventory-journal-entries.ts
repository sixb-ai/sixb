import type { FleetioHttp } from "../http"
import type {
  FleetioInventoryJournalEntry,
  FleetioInventoryJournalEntryCreated,
  FleetioInventoryJournalEntryCreateInput,
  FleetioInventoryJournalEntryFilter,
  FleetioInventoryJournalEntrySort,
  FleetioInventoryJournalEntrySummary,
} from "../types"
import { type FleetioCreateMethod, type FleetioReadMethods, readMethods } from "./crud"

export type InventoryJournalEntriesResource = FleetioReadMethods<
  FleetioInventoryJournalEntrySummary,
  FleetioInventoryJournalEntry,
  FleetioInventoryJournalEntryFilter,
  FleetioInventoryJournalEntrySort
> &
  FleetioCreateMethod<FleetioInventoryJournalEntryCreateInput, FleetioInventoryJournalEntryCreated>

export function inventoryJournalEntriesResource(
  http: FleetioHttp
): InventoryJournalEntriesResource {
  return {
    ...readMethods(http, "inventory_journal_entries", "inventory journal entry id"),
    create(input) {
      return http.post("inventory_journal_entries", input)
    },
  }
}
