import type { MercuryHttp } from "../http"
import { listAllCursor } from "../pagination"
import { cursorQuery } from "../query"
import type {
  MercuryCreateCustomerInput,
  MercuryCustomer,
  MercuryCustomerListOptions,
  MercuryCustomersResponse,
  MercuryUpdateCustomerInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

/** Accounts Receivable customers — the parties invoices are billed to. */
export interface CustomersResource {
  /** `GET /ar/customers` */
  list(options?: MercuryCustomerListOptions): Promise<MercuryCustomersResponse>
  /** Cursor iterator over `GET /ar/customers`. */
  listAll(options?: MercuryCustomerListOptions): AsyncIterable<MercuryCustomer>
  /** `GET /ar/customers/{customerId}` */
  get(customerId: string): Promise<MercuryCustomer>
  /** `POST /ar/customers` */
  create(input: MercuryCreateCustomerInput): Promise<MercuryCustomer>
  /** `POST /ar/customers/{customerId}` — Mercury uses POST, not PUT or PATCH, to edit. */
  update(customerId: string, input: MercuryUpdateCustomerInput): Promise<MercuryCustomer>
  /** `DELETE /ar/customers/{customerId}` — permanent. */
  delete(customerId: string): Promise<void>
}

export function createCustomersResource(http: MercuryHttp): CustomersResource {
  const resource: CustomersResource = {
    list(options) {
      assertCursorOptions(options)
      return http.get("ar/customers", cursorQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, (page) => page.customers, options)
    },
    get(customerId) {
      return http.get(`ar/customers/${pathId(customerId, "customer id")}`)
    },
    create(input) {
      return http.post("ar/customers", input)
    },
    update(customerId, input) {
      return http.post(`ar/customers/${pathId(customerId, "customer id")}`, input)
    },
    delete(customerId) {
      return http.delete(`ar/customers/${pathId(customerId, "customer id")}`)
    },
  }

  return resource
}
