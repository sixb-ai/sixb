import type { PennylaneHttp } from "../http"
import { listAllCursor } from "../pagination"
import { buildListQuery } from "../query"
import type {
  PennylaneCategorizeInput,
  PennylaneCompanyCustomer,
  PennylaneCreateCompanyCustomerInput,
  PennylaneCreateIndividualCustomerInput,
  PennylaneCursorOptions,
  PennylaneCursorPage,
  PennylaneCustomer,
  PennylaneCustomerCategory,
  PennylaneCustomerContact,
  PennylaneCustomerContactListOptions,
  PennylaneCustomerListOptions,
  PennylaneIndividualCustomer,
  PennylaneUpdateCompanyCustomerInput,
  PennylaneUpdateIndividualCustomerInput,
} from "../types"
import { assertCursorOptions, pathId } from "../validation"

export interface CustomersResource {
  /** `GET /customers` (company and individual customers). */
  list(options?: PennylaneCustomerListOptions): Promise<PennylaneCursorPage<PennylaneCustomer>>
  listAll(options?: PennylaneCustomerListOptions): AsyncIterable<PennylaneCustomer>
  /** `GET /customers/{id}` (polymorphic on `customer_type`). */
  get(id: number): Promise<PennylaneCustomer>
  /** `POST /company_customers` */
  createCompany(input: PennylaneCreateCompanyCustomerInput): Promise<PennylaneCompanyCustomer>
  /** `POST /individual_customers` */
  createIndividual(
    input: PennylaneCreateIndividualCustomerInput
  ): Promise<PennylaneIndividualCustomer>
  /** `PUT /company_customers/{id}` */
  updateCompany(
    id: number,
    input: PennylaneUpdateCompanyCustomerInput
  ): Promise<PennylaneCompanyCustomer>
  /** `PUT /individual_customers/{id}` */
  updateIndividual(
    id: number,
    input: PennylaneUpdateIndividualCustomerInput
  ): Promise<PennylaneIndividualCustomer>
  /** `GET /customers/{customer_id}/contacts` */
  listContacts(
    customerId: number,
    options?: PennylaneCustomerContactListOptions
  ): Promise<PennylaneCursorPage<PennylaneCustomerContact>>
  listAllContacts(
    customerId: number,
    options?: PennylaneCustomerContactListOptions
  ): AsyncIterable<PennylaneCustomerContact>
  /** `GET /customers/{customer_id}/categories` */
  listCategories(
    customerId: number,
    options?: PennylaneCursorOptions
  ): Promise<PennylaneCursorPage<PennylaneCustomerCategory>>
  listAllCategories(
    customerId: number,
    options?: PennylaneCursorOptions
  ): AsyncIterable<PennylaneCustomerCategory>
  /** `PUT /customers/{customer_id}/categories` — replaces the customer's categories. */
  categorize(
    customerId: number,
    categories: readonly PennylaneCategorizeInput[]
  ): Promise<readonly PennylaneCustomerCategory[]>
}

export function createCustomersResource(http: PennylaneHttp): CustomersResource {
  const resource: CustomersResource = {
    list(options) {
      assertCursorOptions(options, 100)
      return http.get("customers", buildListQuery(options))
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(id) {
      return http.get(`customers/${pathId(id, "customer id")}`)
    },
    createCompany(input) {
      return http.post("company_customers", input)
    },
    createIndividual(input) {
      return http.post("individual_customers", input)
    },
    updateCompany(id, input) {
      return http.put(`company_customers/${pathId(id, "customer id")}`, input)
    },
    updateIndividual(id, input) {
      return http.put(`individual_customers/${pathId(id, "customer id")}`, input)
    },
    listContacts(customerId, options) {
      assertCursorOptions(options, 100)
      return http.get(
        `customers/${pathId(customerId, "customer id")}/contacts`,
        buildListQuery(options)
      )
    },
    listAllContacts(customerId, options) {
      return listAllCursor((pageOptions) => resource.listContacts(customerId, pageOptions), options)
    },
    listCategories(customerId, options) {
      assertCursorOptions(options, 100)
      return http.get(
        `customers/${pathId(customerId, "customer id")}/categories`,
        buildListQuery(options)
      )
    },
    listAllCategories(customerId, options) {
      return listAllCursor(
        (pageOptions) => resource.listCategories(customerId, pageOptions),
        options
      )
    },
    categorize(customerId, categories) {
      return http.put(`customers/${pathId(customerId, "customer id")}/categories`, categories)
    },
  }

  return resource
}
