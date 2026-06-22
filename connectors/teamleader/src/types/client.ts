import type { ConnectorAdapter, WebhookDefinition } from "@sixb/core"
import type {
  TeamleaderClientOptions,
  TeamleaderInfoRequest,
  TeamleaderListAllOptions,
  TeamleaderListResponse,
  TeamleaderRequestOptions,
  TeamleaderSingleResponse,
} from "./common"
import type {
  TeamleaderCompany,
  TeamleaderCompanyInfoRequest,
  TeamleaderCompanyListItem,
  TeamleaderCompanyListRequest,
} from "./companies"
import type {
  TeamleaderContact,
  TeamleaderContactListItem,
  TeamleaderContactListRequest,
} from "./contacts"
import type {
  TeamleaderCustomFieldDefinition,
  TeamleaderCustomFieldDefinitionListRequest,
} from "./custom-fields"
import type { TeamleaderDeal, TeamleaderDealListItem, TeamleaderDealsListRequest } from "./deals"
import type {
  TeamleaderQuotation,
  TeamleaderQuotationListItem,
  TeamleaderQuotationListRequest,
} from "./quotations"
import type { TeamleaderWebhookRegistration } from "./webhooks"

export interface TeamleaderConnectorOptions extends TeamleaderClientOptions {
  readonly webhooks?: readonly WebhookDefinition<unknown, TeamleaderClient>[]
}

export type TeamleaderConnector = ConnectorAdapter<"teamleader", TeamleaderClient>

export interface TeamleaderClient {
  readonly deals: {
    list(
      request?: TeamleaderDealsListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderDealListItem>>
    listAll(
      request?: TeamleaderDealsListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderDealListItem>
    info(
      request: TeamleaderInfoRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderDeal>>
  }
  readonly quotations: {
    list(
      request?: TeamleaderQuotationListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderQuotationListItem>>
    listAll(
      request?: TeamleaderQuotationListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderQuotationListItem>
    info(
      request: TeamleaderInfoRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderQuotation>>
  }
  readonly contacts: {
    list(
      request?: TeamleaderContactListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderContactListItem>>
    listAll(
      request?: TeamleaderContactListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderContactListItem>
    info(
      request: TeamleaderInfoRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderContact>>
  }
  readonly companies: {
    list(
      request?: TeamleaderCompanyListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderCompanyListItem>>
    listAll(
      request?: TeamleaderCompanyListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderCompanyListItem>
    info(
      request: TeamleaderCompanyInfoRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderCompany>>
  }
  readonly customFieldDefinitions: {
    list(
      request?: TeamleaderCustomFieldDefinitionListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderCustomFieldDefinition>>
    listAll(
      request?: TeamleaderCustomFieldDefinitionListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderCustomFieldDefinition>
    info(
      request: TeamleaderInfoRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderCustomFieldDefinition>>
  }
  readonly webhooks: {
    list(
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderWebhookRegistration>>
    register(
      request: TeamleaderWebhookRegistration,
      options?: TeamleaderRequestOptions
    ): Promise<void>
    unregister(
      request: TeamleaderWebhookRegistration,
      options?: TeamleaderRequestOptions
    ): Promise<void>
  }
}
