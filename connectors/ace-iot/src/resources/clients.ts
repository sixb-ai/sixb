import type { AceIotHttp } from "../http"
import { listAllPages } from "../pagination"
import { pageQuery } from "../query"
import type {
  AceIotClientAccount,
  AceIotClientListAllOptions,
  AceIotClientListOptions,
  AceIotCreateClientInput,
  AceIotCreateDerEventInput,
  AceIotDerEvent,
  AceIotDerEventListAllOptions,
  AceIotDerEventListOptions,
  AceIotPage,
  AceIotSite,
  AceIotSiteListAllOptions,
  AceIotSiteListOptions,
  AceIotUpdateDerEventInput,
  AceIotUploadVolttronAgentPackageInput,
  AceIotVolttronAgentPackage,
  AceIotVolttronAgentPackageListAllOptions,
  AceIotVolttronAgentPackageListOptions,
} from "../types"
import { fileUpload } from "../upload"
import { assertMaxPages, assertPageOptions, pathSegment } from "../validation"

export interface ClientsResource {
  /** `GET /clients/` */
  list(options?: AceIotClientListOptions): Promise<AceIotPage<AceIotClientAccount>>
  listAll(options?: AceIotClientListAllOptions): AsyncIterable<AceIotClientAccount>
  /** `GET /clients/{client_name}` */
  get(clientName: string): Promise<AceIotClientAccount>
  /** `POST /clients/` — ACE documents no response body. */
  create(input: AceIotCreateClientInput): Promise<void>
  /** `GET /clients/{client_name}/sites` */
  listSites(clientName: string, options?: AceIotSiteListOptions): Promise<AceIotPage<AceIotSite>>
  listAllSites(clientName: string, options?: AceIotSiteListAllOptions): AsyncIterable<AceIotSite>
  /** `GET /clients/{client_name}/der_events` — active and upcoming demand-response events. */
  listDerEvents(
    clientName: string,
    options?: AceIotDerEventListOptions
  ): Promise<AceIotPage<AceIotDerEvent>>
  listAllDerEvents(
    clientName: string,
    options?: AceIotDerEventListAllOptions
  ): AsyncIterable<AceIotDerEvent>
  /** `POST /clients/{client_name}/der_events` — ACE documents no response body. */
  createDerEvents(clientName: string, events: readonly AceIotCreateDerEventInput[]): Promise<void>
  /** `PUT /clients/{client_name}/der_events` — edits by id. ACE documents no response body. */
  updateDerEvents(clientName: string, events: readonly AceIotUpdateDerEventInput[]): Promise<void>
  /** `GET /clients/{client_name}/volttron_agent_package/list` */
  listVolttronAgentPackages(
    clientName: string,
    options?: AceIotVolttronAgentPackageListOptions
  ): Promise<AceIotPage<AceIotVolttronAgentPackage>>
  listAllVolttronAgentPackages(
    clientName: string,
    options?: AceIotVolttronAgentPackageListAllOptions
  ): AsyncIterable<AceIotVolttronAgentPackage>
  /**
   * `GET /clients/{client_name}/volttron_agent_package` — the package file. Returns the raw
   * `Response` so the caller decides whether to buffer or stream it.
   */
  downloadVolttronAgentPackage(clientName: string, packageId: string): Promise<Response>
  /** `POST /clients/{client_name}/volttron_agent_package` — ACE documents no response body. */
  uploadVolttronAgentPackage(
    clientName: string,
    input: AceIotUploadVolttronAgentPackageInput
  ): Promise<void>
}

export function createClientsResource(http: AceIotHttp): ClientsResource {
  const resource: ClientsResource = {
    list(options) {
      assertPageOptions(options)
      return http.get("clients/", pageQuery(options))
    },
    listAll(options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.list(pageOptions), options)
    },
    get(clientName) {
      return http.get(`clients/${pathSegment(clientName, "clientName")}`)
    },
    create(input) {
      return http.post("clients/", input)
    },
    listSites(clientName, options) {
      assertPageOptions(options)
      return http.get(`clients/${pathSegment(clientName, "clientName")}/sites`, pageQuery(options))
    },
    listAllSites(clientName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.listSites(clientName, pageOptions), options)
    },
    listDerEvents(clientName, options) {
      assertPageOptions(options)
      return http.get(`clients/${pathSegment(clientName, "clientName")}/der_events`, {
        ...pageQuery(options),
        get_past_events: options?.getPastEvents,
        group_name: options?.groupName,
      })
    },
    listAllDerEvents(clientName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.listDerEvents(clientName, pageOptions), options)
    },
    createDerEvents(clientName, events) {
      return http.post(`clients/${pathSegment(clientName, "clientName")}/der_events`, {
        der_events: events,
      })
    },
    updateDerEvents(clientName, events) {
      return http.put(`clients/${pathSegment(clientName, "clientName")}/der_events`, {
        der_events: events,
      })
    },
    listVolttronAgentPackages(clientName, options) {
      assertPageOptions(options)
      return http.get(
        `clients/${pathSegment(clientName, "clientName")}/volttron_agent_package/list`,
        {
          ...pageQuery(options),
          // Upstream spells the parameter "voltron", without the first t.
          voltron_agent_package_name: options?.packageName,
        }
      )
    },
    listAllVolttronAgentPackages(clientName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) => resource.listVolttronAgentPackages(clientName, pageOptions),
        options
      )
    },
    downloadVolttronAgentPackage(clientName, packageId) {
      return http.download(
        `clients/${pathSegment(clientName, "clientName")}/volttron_agent_package`,
        { volttron_agent_package_id: packageId }
      )
    },
    uploadVolttronAgentPackage(clientName, input) {
      return http.post(
        `clients/${pathSegment(clientName, "clientName")}/volttron_agent_package`,
        fileUpload(input.file, input.filename),
        { package_name: input.packageName, description: input.description }
      )
    },
  }

  return resource
}
