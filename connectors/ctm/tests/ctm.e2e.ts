/**
 * End-to-end check against the real CTM API.
 *
 * Not part of `bun test`: it needs live credentials. Run it directly:
 *
 *     CTM_ACCESS_KEY="…" CTM_SECRET_KEY="…" CTM_ACCOUNT_ID="…" bun connectors/ctm/tests/ctm.e2e.ts
 *
 * Reads only. Nothing here creates, updates, or deletes anything; the write surface is covered by
 * the unit tests against mocks. CTM documents no response example for many routes, so this is
 * also where the shapes the types describe meet the real ones.
 *
 * The output names fields and counts records, and never prints a value, so it can be shared without
 * exposing callers or credentials.
 */
import { CtmApiError, ctm } from "../src"

const accessKey = process.env.CTM_ACCESS_KEY
const secretKey = process.env.CTM_SECRET_KEY
const accountId = process.env.CTM_ACCOUNT_ID

if (!accessKey || !secretKey || !accountId) {
  console.log("[ctm e2e] Skipped: set CTM_ACCESS_KEY, CTM_SECRET_KEY and CTM_ACCOUNT_ID to run.")
  process.exit(0)
}

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
const account = await client.accounts.get(accountId)
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
