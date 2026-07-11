const DEFAULT_API_URL = "http://localhost:3000/api"
const ROOT_SYNC_ID = "sync-erp-departments"

interface RequestSyncRunResponse {
  readonly runId: string
  readonly jobId: string
  readonly syncId: string
  readonly queuedAt: string
}

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

function isRequestSyncRunResponse(value: unknown): value is RequestSyncRunResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "runId" in value &&
    "jobId" in value &&
    "syncId" in value &&
    "queuedAt" in value &&
    typeof value.runId === "string" &&
    typeof value.jobId === "string" &&
    typeof value.syncId === "string" &&
    typeof value.queuedAt === "string"
  )
}

async function requestSyncRun(): Promise<RequestSyncRunResponse> {
  const url = `${apiBaseUrl()}/syncs/${encodeURIComponent(ROOT_SYNC_ID)}/runs`
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commitMessage: "Acme ERP import",
    }),
  })

  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body ? String(body.error) : response.statusText
    throw new Error(`Failed to request ERP sync (${response.status}): ${message}`)
  }

  if (!isRequestSyncRunResponse(body)) {
    throw new Error("Sync request succeeded but returned an unexpected response.")
  }

  return body
}

async function main() {
  const result = await requestSyncRun()
  console.log("[AcmeCorp] Requested ERP sync chain")
  console.log(`[AcmeCorp] Root sync: ${result.syncId}`)
  console.log(`[AcmeCorp] Root run: ${result.runId}`)
  console.log(`[AcmeCorp] Root job: ${result.jobId}`)
  console.log("[AcmeCorp] Downstream syncs will be requested by event schedules.")
  console.log(
    "[AcmeCorp] To slow each sync read for Atlas realtime checks, set ACME_SYNC_DELAY_MS."
  )
  console.log("[AcmeCorp] Document sync includes sample PDF and PNG attachments.")
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[AcmeCorp] ${message}`)
  console.error("[AcmeCorp] Start the example first with `bun run dev`.")
  process.exit(1)
})
