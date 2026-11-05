import type { FleetioHttp } from "../http"
import type {
  FleetioServiceEntryLineItem,
  FleetioServiceEntryLineItemCreated,
  FleetioServiceEntryLineItemCreateInput,
  FleetioServiceEntryLineItemSort,
  FleetioServiceEntryLineItemUpdateInput,
} from "../types"
import { type FleetioNestedMethods, nestedMethods } from "./crud"

/** Line items of a service entry. Every method takes the service entry's ID first. */
export type ServiceEntryLineItemsResource = FleetioNestedMethods<
  FleetioServiceEntryLineItem,
  FleetioServiceEntryLineItem,
  FleetioServiceEntryLineItemCreateInput,
  FleetioServiceEntryLineItemCreated,
  FleetioServiceEntryLineItemUpdateInput,
  void,
  FleetioServiceEntryLineItemSort
>

export function serviceEntryLineItemsResource(http: FleetioHttp): ServiceEntryLineItemsResource {
  return nestedMethods(
    http,
    "service_entries",
    "service entry id",
    "service_entry_line_items",
    "line item id"
  )
}
