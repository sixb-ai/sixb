import type { AceIotHttp } from "../http"
import { listAllPages } from "../pagination"
import { pageQuery, timeRangeQuery } from "../query"
import type {
  AceIotAgentConfig,
  AceIotAgentConfigInput,
  AceIotAgentConfigListAllOptions,
  AceIotAgentConfigListOptions,
  AceIotAgentConfigWriteOptions,
  AceIotCreateVolttronAgentConfigPackageInput,
  AceIotDerEvent,
  AceIotDerEventListAllOptions,
  AceIotDerEventListOptions,
  AceIotGateway,
  AceIotGatewayInput,
  AceIotGatewayListAllOptions,
  AceIotGatewayListOptions,
  AceIotGatewayToken,
  AceIotHawkeConfig,
  AceIotHawkeConfigBaseInput,
  AceIotHawkeConfigInput,
  AceIotHawkeConfigListAllOptions,
  AceIotHawkeConfigListOptions,
  AceIotHawkeConfigOptions,
  AceIotHawkeConfigWithIdentity,
  AceIotHawkeConfigWriteOptions,
  AceIotPage,
  AceIotPcapListAllOptions,
  AceIotPcapListOptions,
  AceIotUpdateGatewayInput,
  AceIotVolttronAgent,
  AceIotVolttronAgentConfigPackage,
  AceIotVolttronAgentConfigPackageOptions,
  AceIotVolttronAgentInput,
  AceIotVolttronAgentListAllOptions,
  AceIotVolttronAgentListOptions,
} from "../types"
import { fileUpload } from "../upload"
import { assertMaxPages, assertPageOptions, pathSegment } from "../validation"

export interface GatewaysResource {
  /** `GET /gateways/` */
  list(options?: AceIotGatewayListOptions): Promise<AceIotPage<AceIotGateway>>
  listAll(options?: AceIotGatewayListAllOptions): AsyncIterable<AceIotGateway>
  /** `GET /gateways/{gateway_name}` */
  get(gatewayName: string): Promise<AceIotGateway>
  /** `POST /gateways/` — ACE documents no response body. */
  create(input: AceIotGatewayInput): Promise<void>
  /** `PATCH /gateways/{gateway_name}` — ACE documents no response body. */
  update(gatewayName: string, input: AceIotUpdateGatewayInput): Promise<void>
  /**
   * `POST /gateways/{gateway_name}/token` — mints a new ACE Manager API token for the gateway.
   * Never retried automatically: a replay issues a second credential.
   */
  createToken(gatewayName: string): Promise<AceIotGatewayToken>
  /** `GET /gateways/{gateway_name}/agent_configs` */
  listAgentConfigs(
    gatewayName: string,
    options?: AceIotAgentConfigListOptions
  ): Promise<AceIotPage<AceIotAgentConfig>>
  listAllAgentConfigs(
    gatewayName: string,
    options?: AceIotAgentConfigListAllOptions
  ): AsyncIterable<AceIotAgentConfig>
  /** `POST /gateways/{gateway_name}/agent_configs` — ACE documents no response body. */
  createAgentConfigs(
    gatewayName: string,
    configs: readonly AceIotAgentConfigInput[],
    options?: AceIotAgentConfigWriteOptions
  ): Promise<void>
  /** `GET /gateways/{gateway_name}/volttron_agents` */
  listVolttronAgents(
    gatewayName: string,
    options?: AceIotVolttronAgentListOptions
  ): Promise<AceIotPage<AceIotVolttronAgent>>
  listAllVolttronAgents(
    gatewayName: string,
    options?: AceIotVolttronAgentListAllOptions
  ): AsyncIterable<AceIotVolttronAgent>
  /**
   * `POST /gateways/{gateway_name}/volttron_agents` — creates agents, overwriting any that share an
   * identity. ACE documents no response body.
   */
  createVolttronAgents(
    gatewayName: string,
    agents: readonly AceIotVolttronAgentInput[]
  ): Promise<void>
  /** `GET /gateways/{gateway_name}/volttron_agent_config_package` */
  getVolttronAgentConfigPackage(
    gatewayName: string,
    volttronAgentIdentity: string,
    options?: AceIotVolttronAgentConfigPackageOptions
  ): Promise<AceIotVolttronAgentConfigPackage>
  /** `POST /gateways/{gateway_name}/volttron_agent_config_package` — no documented response body. */
  createVolttronAgentConfigPackage(
    gatewayName: string,
    input: AceIotCreateVolttronAgentConfigPackageInput,
    options?: AceIotVolttronAgentConfigPackageOptions
  ): Promise<void>
  /** `GET /gateways/{gateway_name}/hawke_configuration` — latest config for every Hawke agent. */
  listHawkeConfigurations(
    gatewayName: string,
    options?: AceIotHawkeConfigListOptions
  ): Promise<AceIotPage<AceIotHawkeConfigWithIdentity>>
  listAllHawkeConfigurations(
    gatewayName: string,
    options?: AceIotHawkeConfigListAllOptions
  ): AsyncIterable<AceIotHawkeConfigWithIdentity>
  /**
   * `POST /gateways/{gateway_name}/hawke_configuration` — pushes configs, or activates ones that
   * already exist. ACE documents no response body.
   */
  createHawkeConfigurations(
    gatewayName: string,
    configs: readonly AceIotHawkeConfigInput[],
    options?: AceIotHawkeConfigWriteOptions
  ): Promise<void>
  /** `GET /gateways/{gateway_name}/hawke_configuration/{hawke_agent_id}` */
  getHawkeAgentConfiguration(
    gatewayName: string,
    hawkeAgentId: string,
    options?: AceIotHawkeConfigOptions
  ): Promise<AceIotHawkeConfig>
  /** `POST /gateways/{gateway_name}/hawke_configuration/{hawke_agent_id}` — no response body. */
  setHawkeAgentConfiguration(
    gatewayName: string,
    hawkeAgentId: string,
    config: AceIotHawkeConfigBaseInput,
    options?: AceIotHawkeConfigWriteOptions
  ): Promise<void>
  /** `GET /gateways/{gateway_name}/hawke_configuration/{hawke_agent_id}/list` */
  listHawkeAgentConfigurations(
    gatewayName: string,
    hawkeAgentId: string,
    options?: AceIotHawkeConfigListOptions
  ): Promise<AceIotPage<AceIotHawkeConfigWithIdentity>>
  listAllHawkeAgentConfigurations(
    gatewayName: string,
    hawkeAgentId: string,
    options?: AceIotHawkeConfigListAllOptions
  ): AsyncIterable<AceIotHawkeConfigWithIdentity>
  /** `GET /gateways/{gateway_name}/der_events` */
  listDerEvents(
    gatewayName: string,
    options?: AceIotDerEventListOptions
  ): Promise<AceIotPage<AceIotDerEvent>>
  listAllDerEvents(
    gatewayName: string,
    options?: AceIotDerEventListAllOptions
  ): AsyncIterable<AceIotDerEvent>
  /** `GET /gateways/{gateway_name}/pcap/list` — capture file names in a time range. */
  listPcapFiles(gatewayName: string, options: AceIotPcapListOptions): Promise<AceIotPage<string>>
  listAllPcapFiles(gatewayName: string, options: AceIotPcapListAllOptions): AsyncIterable<string>
  /** `GET /gateways/{gateway_name}/pcap` — one capture file, as a raw `Response`. */
  downloadPcap(gatewayName: string, fileName: string): Promise<Response>
  /** `POST /gateways/{gateway_name}/pcap` — ACE documents no response body. */
  uploadPcap(gatewayName: string, file: Blob | File, filename?: string): Promise<void>
}

export function createGatewaysResource(http: AceIotHttp): GatewaysResource {
  const gatewayPath = (gatewayName: string) => `gateways/${pathSegment(gatewayName, "gatewayName")}`
  const hawkePath = (gatewayName: string, hawkeAgentId: string) =>
    `${gatewayPath(gatewayName)}/hawke_configuration/${pathSegment(hawkeAgentId, "hawkeAgentId")}`

  const resource: GatewaysResource = {
    list(options) {
      assertPageOptions(options)
      return http.get("gateways/", {
        ...pageQuery(options),
        show_archived: options?.showArchived,
      })
    },
    listAll(options) {
      assertMaxPages(options?.maxPages)
      return listAllPages((pageOptions) => resource.list(pageOptions), options)
    },
    get(gatewayName) {
      return http.get(gatewayPath(gatewayName))
    },
    create(input) {
      return http.post("gateways/", input)
    },
    update(gatewayName, input) {
      return http.patch(gatewayPath(gatewayName), input)
    },
    createToken(gatewayName) {
      return http.post(`${gatewayPath(gatewayName)}/token`)
    },
    listAgentConfigs(gatewayName, options) {
      assertPageOptions(options)
      return http.get(`${gatewayPath(gatewayName)}/agent_configs`, {
        ...pageQuery(options),
        agent_identity: options?.agentIdentity,
        active: options?.active,
        use_base64_hash: options?.useBase64Hash,
      })
    },
    listAllAgentConfigs(gatewayName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) => resource.listAgentConfigs(gatewayName, pageOptions),
        options
      )
    },
    createAgentConfigs(gatewayName, configs, options) {
      return http.post(
        `${gatewayPath(gatewayName)}/agent_configs`,
        { agent_configs: configs },
        { use_base64_hash: options?.useBase64Hash }
      )
    },
    listVolttronAgents(gatewayName, options) {
      assertPageOptions(options)
      return http.get(`${gatewayPath(gatewayName)}/volttron_agents`, {
        ...pageQuery(options),
        volttron_agent_identity: options?.volttronAgentIdentity,
      })
    },
    listAllVolttronAgents(gatewayName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) => resource.listVolttronAgents(gatewayName, pageOptions),
        options
      )
    },
    createVolttronAgents(gatewayName, agents) {
      return http.post(`${gatewayPath(gatewayName)}/volttron_agents`, { volttron_agents: agents })
    },
    getVolttronAgentConfigPackage(gatewayName, volttronAgentIdentity, options) {
      return http.get(`${gatewayPath(gatewayName)}/volttron_agent_config_package`, {
        volttron_agent_identity: volttronAgentIdentity,
        use_agent_config_base64_hash: options?.useAgentConfigBase64Hash,
      })
    },
    createVolttronAgentConfigPackage(gatewayName, input, options) {
      return http.post(`${gatewayPath(gatewayName)}/volttron_agent_config_package`, input, {
        use_agent_config_base64_hash: options?.useAgentConfigBase64Hash,
      })
    },
    listHawkeConfigurations(gatewayName, options) {
      assertPageOptions(options)
      return http.get(`${gatewayPath(gatewayName)}/hawke_configuration`, {
        ...pageQuery(options),
        hash: options?.hash,
        use_base64_hash: options?.useBase64Hash,
      })
    },
    listAllHawkeConfigurations(gatewayName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) => resource.listHawkeConfigurations(gatewayName, pageOptions),
        options
      )
    },
    createHawkeConfigurations(gatewayName, configs, options) {
      return http.post(
        `${gatewayPath(gatewayName)}/hawke_configuration`,
        { hawke_agents: configs },
        { use_base64_hash: options?.useBase64Hash }
      )
    },
    getHawkeAgentConfiguration(gatewayName, hawkeAgentId, options) {
      return http.get(hawkePath(gatewayName, hawkeAgentId), {
        hash: options?.hash,
        use_base64_hash: options?.useBase64Hash,
      })
    },
    setHawkeAgentConfiguration(gatewayName, hawkeAgentId, config, options) {
      return http.post(hawkePath(gatewayName, hawkeAgentId), config, {
        use_base64_hash: options?.useBase64Hash,
      })
    },
    listHawkeAgentConfigurations(gatewayName, hawkeAgentId, options) {
      assertPageOptions(options)
      return http.get(`${hawkePath(gatewayName, hawkeAgentId)}/list`, {
        ...pageQuery(options),
        use_base64_hash: options?.useBase64Hash,
      })
    },
    listAllHawkeAgentConfigurations(gatewayName, hawkeAgentId, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) =>
          resource.listHawkeAgentConfigurations(gatewayName, hawkeAgentId, pageOptions),
        options
      )
    },
    listDerEvents(gatewayName, options) {
      assertPageOptions(options)
      return http.get(`${gatewayPath(gatewayName)}/der_events`, {
        ...pageQuery(options),
        get_past_events: options?.getPastEvents,
        group_name: options?.groupName,
      })
    },
    listAllDerEvents(gatewayName, options) {
      assertMaxPages(options?.maxPages)
      return listAllPages(
        (pageOptions) => resource.listDerEvents(gatewayName, pageOptions),
        options
      )
    },
    listPcapFiles(gatewayName, options) {
      assertPageOptions(options)
      return http.get(`${gatewayPath(gatewayName)}/pcap/list`, {
        ...pageQuery(options),
        ...timeRangeQuery(options),
      })
    },
    listAllPcapFiles(gatewayName, options) {
      assertMaxPages(options.maxPages)
      return listAllPages(
        (pageOptions) => resource.listPcapFiles(gatewayName, pageOptions),
        options
      )
    },
    downloadPcap(gatewayName, fileName) {
      return http.download(`${gatewayPath(gatewayName)}/pcap`, { file_name: fileName })
    },
    uploadPcap(gatewayName, file, filename) {
      return http.post(`${gatewayPath(gatewayName)}/pcap`, fileUpload(file, filename))
    },
  }

  return resource
}
