import type { TeamleaderRequester } from "../http"
import { listAll } from "../pagination"
import type {
  TeamleaderClient,
  TeamleaderDocumentTemplate,
  TeamleaderListResponse,
  TeamleaderPaymentMethod,
  TeamleaderPaymentTerm,
  TeamleaderPaymentTermsMeta,
  TeamleaderPriceList,
  TeamleaderProductCategory,
  TeamleaderTaxRate,
  TeamleaderUnitOfMeasure,
} from "../types"

export function createProductCategoriesResource(
  request: TeamleaderRequester
): TeamleaderClient["productCategories"] {
  return {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderProductCategory>>(
        "/productCategories.list",
        body,
        requestOptions
      )
    },
  }
}

export function createPriceListsResource(
  request: TeamleaderRequester
): TeamleaderClient["priceLists"] {
  return {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderPriceList>>(
        "/priceLists.list",
        body,
        requestOptions
      )
    },
  }
}

export function createTaxRatesResource(request: TeamleaderRequester): TeamleaderClient["taxRates"] {
  const resource: TeamleaderClient["taxRates"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderTaxRate>>(
        "/taxRates.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
  }

  return resource
}

export function createUnitsOfMeasureResource(
  request: TeamleaderRequester
): TeamleaderClient["unitsOfMeasure"] {
  return {
    list(requestOptions) {
      return request<TeamleaderListResponse<TeamleaderUnitOfMeasure>>(
        "/unitsOfMeasure.list",
        undefined,
        requestOptions
      )
    },
  }
}

export function createPaymentTermsResource(
  request: TeamleaderRequester
): TeamleaderClient["paymentTerms"] {
  return {
    list(requestOptions) {
      return request<TeamleaderListResponse<TeamleaderPaymentTerm, TeamleaderPaymentTermsMeta>>(
        "/paymentTerms.list",
        undefined,
        requestOptions
      )
    },
  }
}

export function createPaymentMethodsResource(
  request: TeamleaderRequester
): TeamleaderClient["paymentMethods"] {
  const resource: TeamleaderClient["paymentMethods"] = {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderPaymentMethod>>(
        "/paymentMethods.list",
        body,
        requestOptions
      )
    },
    listAll(body, requestOptions) {
      return listAll(resource.list, body, requestOptions)
    },
  }

  return resource
}

export function createDocumentTemplatesResource(
  request: TeamleaderRequester
): TeamleaderClient["documentTemplates"] {
  return {
    list(body, requestOptions) {
      return request<TeamleaderListResponse<TeamleaderDocumentTemplate>>(
        "/documentTemplates.list",
        body,
        requestOptions
      )
    },
  }
}
