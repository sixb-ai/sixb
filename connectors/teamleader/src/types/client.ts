import type { ConnectorAdapter, WebhookDefinition } from "@sixb/core"
import type {
  TeamleaderClientOptions,
  TeamleaderInfoRequest,
  TeamleaderListAllOptions,
  TeamleaderListResponse,
  TeamleaderRequestOptions,
  TeamleaderSingleResponse,
  TeamleaderTypeAndId,
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
  TeamleaderProduct,
  TeamleaderProductInfoRequest,
  TeamleaderProductListItem,
  TeamleaderProductListRequest,
} from "./products"
import type {
  TeamleaderDocumentTemplate,
  TeamleaderDocumentTemplateListRequest,
  TeamleaderPaymentMethod,
  TeamleaderPaymentMethodListRequest,
  TeamleaderPaymentTerm,
  TeamleaderPaymentTermsMeta,
  TeamleaderPriceList,
  TeamleaderPriceListListRequest,
  TeamleaderProductCategory,
  TeamleaderProductCategoryListRequest,
  TeamleaderTaxRate,
  TeamleaderTaxRateListRequest,
  TeamleaderUnitOfMeasure,
} from "./quotation-references"
import type {
  TeamleaderQuotation,
  TeamleaderQuotationCreateRequest,
  TeamleaderQuotationDownload,
  TeamleaderQuotationDownloadRequest,
  TeamleaderQuotationListItem,
  TeamleaderQuotationListRequest,
  TeamleaderQuotationSendRequest,
  TeamleaderQuotationUpdateRequest,
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
    create(
      request: TeamleaderQuotationCreateRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderTypeAndId<"quotation">>>
    download(
      request: TeamleaderQuotationDownloadRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderQuotationDownload>>
    send(request: TeamleaderQuotationSendRequest, options?: TeamleaderRequestOptions): Promise<void>
    update(
      request: TeamleaderQuotationUpdateRequest,
      options?: TeamleaderRequestOptions
    ): Promise<void>
    accept(request: TeamleaderInfoRequest, options?: TeamleaderRequestOptions): Promise<void>
    delete(request: TeamleaderInfoRequest, options?: TeamleaderRequestOptions): Promise<void>
  }
  readonly products: {
    list(
      request?: TeamleaderProductListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderProductListItem>>
    listAll(
      request?: TeamleaderProductListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderProductListItem>
    info(
      request: TeamleaderProductInfoRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderSingleResponse<TeamleaderProduct>>
  }
  readonly productCategories: {
    list(
      request?: TeamleaderProductCategoryListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderProductCategory>>
  }
  readonly priceLists: {
    list(
      request?: TeamleaderPriceListListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderPriceList>>
  }
  readonly taxRates: {
    list(
      request?: TeamleaderTaxRateListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderTaxRate>>
    listAll(
      request?: TeamleaderTaxRateListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderTaxRate>
  }
  readonly unitsOfMeasure: {
    list(
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderUnitOfMeasure>>
  }
  readonly paymentTerms: {
    list(
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderPaymentTerm, TeamleaderPaymentTermsMeta>>
  }
  readonly paymentMethods: {
    list(
      request?: TeamleaderPaymentMethodListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderPaymentMethod>>
    listAll(
      request?: TeamleaderPaymentMethodListRequest,
      options?: TeamleaderListAllOptions
    ): AsyncIterable<TeamleaderPaymentMethod>
  }
  readonly documentTemplates: {
    list(
      request: TeamleaderDocumentTemplateListRequest,
      options?: TeamleaderRequestOptions
    ): Promise<TeamleaderListResponse<TeamleaderDocumentTemplate>>
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
