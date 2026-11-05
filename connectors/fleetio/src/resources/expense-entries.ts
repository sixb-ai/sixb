import type { FleetioHttp } from "../http"
import type {
  FleetioExpenseEntry,
  FleetioExpenseEntryCreated,
  FleetioExpenseEntryCreateInput,
  FleetioExpenseEntryFilter,
  FleetioExpenseEntrySort,
  FleetioExpenseEntrySummary,
  FleetioExpenseEntryUpdateInput,
} from "../types"
import {
  type FleetioReadMethods,
  type FleetioWriteMethods,
  readMethods,
  writeMethods,
} from "./crud"

export type ExpenseEntriesResource = FleetioReadMethods<
  FleetioExpenseEntrySummary,
  FleetioExpenseEntry,
  FleetioExpenseEntryFilter,
  FleetioExpenseEntrySort
> &
  FleetioWriteMethods<
    FleetioExpenseEntryCreateInput,
    FleetioExpenseEntryCreated,
    FleetioExpenseEntryUpdateInput
  >

export function expenseEntriesResource(http: FleetioHttp): ExpenseEntriesResource {
  return {
    ...readMethods(http, "expense_entries", "expense entry id"),
    ...writeMethods(http, "expense_entries", "expense entry id"),
  }
}
