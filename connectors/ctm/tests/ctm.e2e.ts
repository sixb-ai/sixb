/**
 * End-to-end check against the real CTM API.
 *
 * Not part of `bun test`: it needs live credentials. Run it directly:
 *
 *     CTM_ACCESS_KEY="…" CTM_SECRET_KEY="…" CTM_ACCOUNT_ID="…" bun connectors/ctm/tests/ctm.e2e.ts
 *
 * Reads only. Nothing here creates, updates, or deletes anything; the write surface is covered by
 * the unit tests against mocks. `fetch` is wrapped to refuse, before it leaves, any request that is
 * not a GET or the call search (a POST CTM documents as a search), so a change to this script cannot
 * write to the account by mistake. CTM documents no response example for many routes, so this is
 * also where the shapes the types describe meet the real ones.
 *
 * The output names fields, counts records and lists the IDs of the accounts the key reaches, and
 * prints no other value, so it can be shared without exposing callers or credentials.
 */
import { CtmApiError, ctm } from "../src"

const accessKey = process.env.CTM_ACCESS_KEY
const secretKey = process.env.CTM_SECRET_KEY
const accountId = process.env.CTM_ACCOUNT_ID

if (!accessKey || !secretKey || !accountId) {
  console.log("[ctm e2e] Skipped: set CTM_ACCESS_KEY, CTM_SECRET_KEY and CTM_ACCOUNT_ID to run.")
  process.exit(0)
}

const realFetch = globalThis.fetch

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  const url = new URL(input instanceof Request ? input.url : String(input))
  const isSearch = method === "POST" && url.pathname.endsWith("/calls/search.json")

  if (method !== "GET" && !isSearch) {
    throw new Error(`[ctm e2e] Refused ${method} ${url.pathname}: this check only reads.`)
  }

  return realFetch(input, init)
}) as typeof fetch

const client = await ctm({ accessKey, secretKey, accountId, timeoutMs: 60_000 }).connect({
  projectId: "e2e",
  connectorId: "ctm",
  signal: new AbortController().signal,
})

let failures = 0

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }

  failures += 1
  console.log(`  ✗ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
}

/** Plan-gated features answer 403 or 404, which says nothing about the connector. */
async function optional(label: string, read: () => Promise<unknown>) {
  try {
    const result = await read()
    console.log(`  ✓ ${label}${describeShape(result)}`)
  } catch (error) {
    if (error instanceof CtmApiError && (error.status === 403 || error.status === 404)) {
      console.log(`  - ${label}: not available on this account (${error.status})`)
      return
    }

    failures += 1
    console.log(`  ✗ ${label} — ${String(error)}`)
  }
}

/** Ends the run on an API error a later check could not get past, saying what to look at. */
function stop(label: string, error: unknown): never {
  if (!(error instanceof CtmApiError)) {
    throw error
  }

  console.log(`  ✗ ${label}: ${error.message}`)
  if (error.status === 401) {
    console.log(
      "    CTM rejected the key: check that API access is on, and the access and secret keys."
    )
  }

  process.exit(1)
}

/** The envelope's record count and the first record's fields, to compare against the types. */
function describeShape(result: unknown): string {
  if (typeof result !== "object" || result === null) {
    return ""
  }

  const records = "records" in result && Array.isArray(result.records) ? result.records : null
  const first = records?.[0] ?? result

  return ` (${records ? `${records.length} records, ` : ""}fields: ${Object.keys(first).slice(0, 12).join(", ")})`
}

console.log("\naccount")

const reachableIds: string[] = []
try {
  for await (const reachable of client.accounts.listAll()) {
    reachableIds.push(String(reachable.id))
  }
} catch (error) {
  stop("accounts.listAll", error)
}

console.log(`  ✓ the key reaches ${reachableIds.length} account(s): ${reachableIds.join(", ")}`)

if (!reachableIds.includes(accountId)) {
  console.log(`  ✗ CTM_ACCOUNT_ID ${accountId} is not one of them: set it to one of the IDs above.`)
  process.exit(1)
}

const account = await client.accounts
  .get(accountId)
  .catch((error: unknown) => stop("accounts.get", error))
check("accounts.get reads the key's account", String(account.id) === accountId, account.id)
await optional("agency.get", () => client.agency.get())

console.log("\ncall log")
const page = await client.calls.list({ timeDuration: "last7days", pageSize: 3 })
check("calls.list reads the cursor envelope", Array.isArray(page.records), Object.keys(page))
check("calls.list reports a total", page.totalEntries !== null, page.totalEntries)

const call = page.records[0]
if (call) {
  const detail = await client.calls.get(call.id)
  check("calls.get returns the same call", detail.id === call.id)
  check("calls.get includes the caller", detail.caller !== undefined, Object.keys(detail))

  if (page.after) {
    const next = await client.calls.list({
      timeDuration: "last7days",
      pageSize: 3,
      after: page.after,
    })
    check("the after cursor reaches another page", next.records[0]?.id !== call.id)
  }

  await optional("calls.transcript", () => client.calls.transcript(call.id))
  await optional("calls.getSale", () => client.calls.getSale(call.id))

  if (detail.audio) {
    const recording = await client.calls.recording(call.sid)
    check("calls.recording returns audio", Boolean(recording.headers.get("content-type")))
    await recording.body?.cancel()
  }
} else {
  console.log("  - no activity in the last 7 days: detail checks skipped")
}

await optional("calls.search", () =>
  client.calls.search({ timeDuration: "last7days", pageSize: 1 })
)
await optional("calls.mapping", () => client.calls.mapping())

console.log("\nreferences")
await optional("trackingNumbers.list", () => client.trackingNumbers.list({ pageSize: 2 }))
await optional("receivingNumbers.list", () => client.receivingNumbers.list({ pageSize: 2 }))
await optional("sources.list", () => client.sources.list({ pageSize: 2 }))
await optional("users.list", () => client.users.list({ pageSize: 2 }))
await optional("agents.list", () => client.agents.list())
await optional("queues.list", () => client.queues.list())
await optional("customFields.list", () => client.customFields.list())
await optional("lookup tags", () => client.lookup.list("tag"))
await optional("sms.list", () => client.sms.list({ pageSize: 2 }))
await optional("webhooks.list", () => client.webhooks.list())

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
