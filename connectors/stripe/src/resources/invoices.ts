import type Stripe from "stripe"
import type {
  StripeListPromise,
  StripeRequestOptions,
  StripeResponse,
  StripeSearchPromise,
} from "../types"
import { assertCursorOptions, assertPageLimit, stripeId } from "../validation"

export type StripeInvoice = Stripe.Invoice
export type StripeDeletedInvoice = Stripe.DeletedInvoice
export type StripeInvoiceCreateParams = Stripe.InvoiceCreateParams
export type StripeInvoiceCreatePreviewParams = Stripe.InvoiceCreatePreviewParams
export type StripeInvoiceUpdateParams = Stripe.InvoiceUpdateParams
export type StripeInvoiceRetrieveParams = Stripe.InvoiceRetrieveParams
export type StripeInvoiceListParams = Stripe.InvoiceListParams
export type StripeInvoiceDeleteParams = Stripe.InvoiceDeleteParams
export type StripeInvoiceSearchParams = Stripe.InvoiceSearchParams
export type StripeInvoiceAttachPaymentParams = Stripe.InvoiceAttachPaymentParams
export type StripeInvoiceFinalizeParams = Stripe.InvoiceFinalizeInvoiceParams
export type StripeInvoiceMarkUncollectibleParams = Stripe.InvoiceMarkUncollectibleParams
export type StripeInvoicePayParams = Stripe.InvoicePayParams
export type StripeInvoiceSendParams = Stripe.InvoiceSendInvoiceParams
export type StripeInvoiceVoidParams = Stripe.InvoiceVoidInvoiceParams
export type StripeInvoiceLineItem = Stripe.InvoiceLineItem
export type StripeInvoiceListLineItemsParams = Stripe.InvoiceListLineItemsParams
export type StripeInvoiceUpdateLineItemParams = Stripe.InvoiceUpdateLineItemParams
export type StripeInvoiceAddLinesParams = Stripe.InvoiceAddLinesParams
export type StripeInvoiceUpdateLinesParams = Stripe.InvoiceUpdateLinesParams
export type StripeInvoiceRemoveLinesParams = Stripe.InvoiceRemoveLinesParams

export interface InvoicesResource {
  /** `GET /v1/invoices/{id}/lines` — the complete paginated collection. */
  listLineItems(
    id: string,
    params?: StripeInvoiceListLineItemsParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeInvoiceLineItem>
  /** Auto-paginated iterator over `GET /v1/invoices/{id}/lines`. */
  listAllLineItems(
    id: string,
    params?: StripeInvoiceListLineItemsParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeInvoiceLineItem>
  /** `POST /v1/invoices/{id}/lines/{lineId}` — before finalization only. */
  updateLineItem(
    id: string,
    lineId: string,
    params?: StripeInvoiceUpdateLineItemParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoiceLineItem>>
  /** `POST /v1/invoices/{id}/add_lines` — draft invoices only. */
  addLines(
    id: string,
    params: StripeInvoiceAddLinesParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/update_lines` — draft invoices only. */
  updateLines(
    id: string,
    params: StripeInvoiceUpdateLinesParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/remove_lines` — explicit delete or unassign per line. */
  removeLines(
    id: string,
    params: StripeInvoiceRemoveLinesParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices` — creates a draft invoice. */
  create(
    params?: StripeInvoiceCreateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/create_preview` — returns an ephemeral invoice preview. */
  createPreview(
    params?: StripeInvoiceCreatePreviewParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}` */
  update(
    id: string,
    params?: StripeInvoiceUpdateParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `GET /v1/invoices/{id}` */
  get(
    id: string,
    params?: StripeInvoiceRetrieveParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `GET /v1/invoices` */
  list(
    params?: StripeInvoiceListParams,
    options?: StripeRequestOptions
  ): StripeListPromise<StripeInvoice>
  /** Auto-paginated iterator over `GET /v1/invoices`. */
  listAll(
    params?: StripeInvoiceListParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeInvoice>
  /** `DELETE /v1/invoices/{id}` — draft one-off invoices only. */
  delete(
    id: string,
    params?: StripeInvoiceDeleteParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeDeletedInvoice>>
  /** `POST /v1/invoices/{id}/attach_payment` */
  attachPayment(
    id: string,
    params?: StripeInvoiceAttachPaymentParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/finalize` */
  finalize(
    id: string,
    params?: StripeInvoiceFinalizeParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/mark_uncollectible` */
  markUncollectible(
    id: string,
    params?: StripeInvoiceMarkUncollectibleParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/pay` */
  pay(
    id: string,
    params?: StripeInvoicePayParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/send` */
  send(
    id: string,
    params?: StripeInvoiceSendParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `POST /v1/invoices/{id}/void` — irreversible. */
  void(
    id: string,
    params?: StripeInvoiceVoidParams,
    options?: StripeRequestOptions
  ): Promise<StripeResponse<StripeInvoice>>
  /** `GET /v1/invoices/search` — eventually consistent and unavailable in India. */
  search(
    params: StripeInvoiceSearchParams,
    options?: StripeRequestOptions
  ): StripeSearchPromise<StripeInvoice>
  /** Auto-paginated iterator over `GET /v1/invoices/search`. */
  searchAll(
    params: StripeInvoiceSearchParams,
    options?: StripeRequestOptions
  ): AsyncIterable<StripeInvoice>
}

export function createInvoicesResource(sdk: Stripe): InvoicesResource {
  return {
    listLineItems(id, params, options) {
      assertCursorOptions(params)
      return sdk.invoices.listLineItems(stripeId(id, "invoice id"), params, options)
    },
    listAllLineItems(id, params, options) {
      assertCursorOptions(params)
      return sdk.invoices.listLineItems(stripeId(id, "invoice id"), params, options)
    },
    updateLineItem(id, lineId, params, options) {
      return sdk.invoices.updateLineItem(
        stripeId(id, "invoice id"),
        stripeId(lineId, "invoice line item id"),
        params,
        options
      )
    },
    addLines(id, params, options) {
      return sdk.invoices.addLines(stripeId(id, "invoice id"), params, options)
    },
    updateLines(id, params, options) {
      return sdk.invoices.updateLines(stripeId(id, "invoice id"), params, options)
    },
    removeLines(id, params, options) {
      return sdk.invoices.removeLines(stripeId(id, "invoice id"), params, options)
    },
    create(params, options) {
      return sdk.invoices.create(params, options)
    },
    createPreview(params, options) {
      return sdk.invoices.createPreview(params, options)
    },
    update(id, params, options) {
      return sdk.invoices.update(stripeId(id, "invoice id"), params, options)
    },
    get(id, params, options) {
      return sdk.invoices.retrieve(stripeId(id, "invoice id"), params, options)
    },
    list(params, options) {
      assertCursorOptions(params)
      return sdk.invoices.list(params, options)
    },
    listAll(params, options) {
      assertCursorOptions(params)
      return sdk.invoices.list(params, options)
    },
    delete(id, params, options) {
      return sdk.invoices.del(stripeId(id, "invoice id"), params, options)
    },
    attachPayment(id, params, options) {
      return sdk.invoices.attachPayment(stripeId(id, "invoice id"), params, options)
    },
    finalize(id, params, options) {
      return sdk.invoices.finalizeInvoice(stripeId(id, "invoice id"), params, options)
    },
    markUncollectible(id, params, options) {
      return sdk.invoices.markUncollectible(stripeId(id, "invoice id"), params, options)
    },
    pay(id, params, options) {
      return sdk.invoices.pay(stripeId(id, "invoice id"), params, options)
    },
    send(id, params, options) {
      return sdk.invoices.sendInvoice(stripeId(id, "invoice id"), params, options)
    },
    void(id, params, options) {
      return sdk.invoices.voidInvoice(stripeId(id, "invoice id"), params, options)
    },
    search(params, options) {
      assertPageLimit(params.limit)
      return sdk.invoices.search(params, options)
    },
    searchAll(params, options) {
      assertPageLimit(params.limit)
      return sdk.invoices.search(params, options)
    },
  }
}
