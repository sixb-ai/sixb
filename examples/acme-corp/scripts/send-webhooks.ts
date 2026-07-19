const DEFAULT_API_URL = "http://localhost:3002/api"
const WEBHOOK_PATH = "/webhooks/acme-erp/invoice-events"
const LOCAL_WEBHOOK_SIGNATURE = "acme-local-secret"

interface DemoDelivery {
  readonly label: string
  readonly method?: "GET" | "POST"
  readonly deliveryId?: string
  readonly signature?: string
  readonly body?: unknown
}

const demoDeliveries: readonly DemoDelivery[] = [
  {
    label: "accepted invoice.created",
    deliveryId: "demo-delivery-001",
    body: {
      deliveryId: "demo-delivery-001",
      type: "invoice.created",
      invoiceId: "INV-DEMO-001",
    },
  },
  {
    label: "duplicate invoice.created",
    deliveryId: "demo-delivery-001",
    body: {
      deliveryId: "demo-delivery-001",
      type: "invoice.created",
      invoiceId: "INV-DEMO-001",
    },
  },
  {
    label: "accepted invoice.paid",
    deliveryId: "demo-delivery-002",
    body: {
      deliveryId: "demo-delivery-002",
      type: "invoice.paid",
      invoiceId: "INV-DEMO-002",
    },
  },
  {
    label: "invalid payload",
    deliveryId: "demo-delivery-003",
    body: {
      deliveryId: "demo-delivery-003",
      type: "invoice.paid",
    },
  },
  {
    label: "handler failure",
    deliveryId: "demo-delivery-004",
    body: {
      deliveryId: "demo-delivery-004",
      type: "invoice.failed",
      invoiceId: "INV-DEMO-004",
      shouldFail: true,
    },
  },
  {
    label: "bad signature",
    deliveryId: "demo-delivery-005",
    signature: "wrong-secret",
    body: {
      deliveryId: "demo-delivery-005",
      type: "invoice.created",
      invoiceId: "INV-DEMO-005",
    },
  },
  {
    label: "wrong method",
    method: "GET",
  },
]

function argValue(name: string): string | undefined {
  const args = process.argv.slice(2)
  const direct = args.find((arg) => arg.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)

  const index = args.indexOf(`--${name}`)
  if (index >= 0) return args[index + 1]

  return undefined
}

function apiBaseUrl(): string {
  const raw = argValue("url") ?? process.env.SIXB_API_URL ?? process.env.SIXB_URL ?? DEFAULT_API_URL
  const url = raw.replace(/\/+$/, "")
  return url.endsWith("/api") ? url : `${url}/api`
}

async function sendDelivery(apiUrl: string, delivery: DemoDelivery): Promise<void> {
  const method = delivery.method ?? "POST"
  const headers = new Headers()
  headers.set("x-acme-signature", delivery.signature ?? LOCAL_WEBHOOK_SIGNATURE)

  if (delivery.deliveryId) {
    headers.set("x-acme-delivery", delivery.deliveryId)
  }

  let body: string | undefined
  if (method === "POST") {
    headers.set("content-type", "application/json")
    body = JSON.stringify(delivery.body ?? {})
  }

  const response = await fetch(`${apiUrl}${WEBHOOK_PATH}`, {
    method,
    headers,
    body,
  })
  const responseBody = await response.text()
  const summary = responseBody ? ` ${responseBody}` : ""

  console.log(`[AcmeCorp] ${delivery.label}: HTTP ${response.status}${summary}`)
}

async function main(): Promise<void> {
  const apiUrl = apiBaseUrl()

  for (const delivery of demoDeliveries) {
    await sendDelivery(apiUrl, delivery)
  }

  console.log("[AcmeCorp] Demo webhook runs sent.")
  console.log("[AcmeCorp] Open Connectors > Acme Erp > Recent Webhook Runs in the UI.")
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[AcmeCorp] ${message}`)
  console.error("[AcmeCorp] Start the example first with `bun run dev`.")
  process.exit(1)
})

export {}
