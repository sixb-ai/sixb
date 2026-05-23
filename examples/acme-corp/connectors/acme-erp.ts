import { defineConnector, defineWebhook } from "@sixb/core"
import { createAcmeErpClient } from "../lib/acme-erp"

export interface AcmeInvoiceWebhookEvent {
  readonly deliveryId: string
  readonly type: "invoice.created" | "invoice.paid" | "invoice.failed"
  readonly invoiceId: string
  readonly shouldFail?: boolean
}

const LOCAL_WEBHOOK_SIGNATURE = "acme-local-secret"

export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  webhooks: [
    defineWebhook("invoice-events")
      .post()
      .json({ parse: parseInvoiceWebhookEvent })
      .verify(({ request }) => {
        if (request.headers.get("x-acme-signature") !== LOCAL_WEBHOOK_SIGNATURE) {
          throw new Error("Invalid Acme webhook signature")
        }
      })
      .idempotencyKey(
        ({ body, request }) => request.headers.get("x-acme-delivery") ?? body.deliveryId
      )
      .handle(({ body }) => {
        if (body.shouldFail) {
          throw new Error(`[AcmeCorp] Demo webhook failure for ${body.invoiceId}`)
        }

        console.log(`[AcmeCorp] Received ${body.type} webhook for ${body.invoiceId}`)
      }),
  ],
  connect() {
    return createAcmeErpClient()
  },
})

function parseInvoiceWebhookEvent(value: unknown): AcmeInvoiceWebhookEvent {
  if (!isRecord(value)) {
    throw new Error("Webhook body must be an object")
  }

  const { deliveryId, type, invoiceId, shouldFail } = value
  if (typeof deliveryId !== "string" || deliveryId.trim() === "") {
    throw new Error("deliveryId is required")
  }
  if (type !== "invoice.created" && type !== "invoice.paid" && type !== "invoice.failed") {
    throw new Error("type must be invoice.created, invoice.paid, or invoice.failed")
  }
  if (typeof invoiceId !== "string" || invoiceId.trim() === "") {
    throw new Error("invoiceId is required")
  }
  if (shouldFail !== undefined && typeof shouldFail !== "boolean") {
    throw new Error("shouldFail must be a boolean")
  }

  return {
    deliveryId,
    type,
    invoiceId,
    shouldFail,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
