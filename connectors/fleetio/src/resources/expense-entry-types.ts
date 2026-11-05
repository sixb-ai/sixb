import type { FleetioHttp } from "../http"
import type {
  FleetioExpenseEntryType,
  FleetioExpenseEntryTypeFilter,
  FleetioExpenseEntryTypeSort,
} from "../types"
import { type FleetioReadMethods, readMethods } from "./crud"

export type ExpenseEntryTypesResource = FleetioReadMethods<
  FleetioExpenseEntryType,
  FleetioExpenseEntryType,
  FleetioExpenseEntryTypeFilter,
  FleetioExpenseEntryTypeSort
>

export function expenseEntryTypesResource(http: FleetioHttp): ExpenseEntryTypesResource {
  return readMethods(http, "expense_entry_types", "expense entry type id")
}
